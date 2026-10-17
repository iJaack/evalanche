/**
 * KyberSwap MetaAggregationRouterV2 `swap` (0xe21fd0e9) inside a Li.Fi V3 leg.
 * The bytes are the Kyber execution nested in Avalanche tx
 * 0xfbf79e26d003a4134e1062261143d9753a3b211455907ceff45944636474d346.
 * That outer call is not a V3 selector, so the test wraps the real swap
 * calldata in a V3 leg.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import {
  computeApprovedTxHash,
  generateEd25519KeyPair,
  signVerifierApproval,
  startSignerServer,
} from '../../src/index';
import {
  KYBER_META_AGGREGATION_ROUTER_V2,
  KYBER_SWAP_SELECTOR,
  LIFI_DIAMOND,
  SELECTOR,
  decodeCalldata,
  type AllowRole,
  type DecodeOptions,
} from '../../src/signer/decode';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';
import type { AllowEntry } from '../../src/signer/server';
export { fixture };
import fixture from '../signer/fixtures/kyber-avalanche-swap.json';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN = 43114;
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const V3 = new Interface([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG}[] swapData)`,
]);
const KYBER = new Interface([
  'function swap((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);

interface Leg {
  callTo: string;
  approveTo: string;
  sendingAssetId: string;
  receivingAssetId: string;
  fromAmount: bigint;
  callData: string;
  requiresDeposit: boolean;
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

function kyberExecution(calldata: string) {
  const decoded = KYBER.decodeFunctionData('swap', calldata);
  const execution = decoded[0];
  return {
    callTarget: execution.callTarget,
    approveTarget: execution.approveTarget,
    targetData: execution.targetData,
    clientData: execution.clientData,
    desc: {
      srcToken: execution.desc.srcToken,
      dstToken: execution.desc.dstToken,
      srcReceivers: [...execution.desc.srcReceivers],
      srcAmounts: [...execution.desc.srcAmounts],
      feeReceivers: [...execution.desc.feeReceivers],
      feeAmounts: [...execution.desc.feeAmounts],
      dstReceiver: execution.desc.dstReceiver,
      amount: execution.desc.amount,
      minReturnAmount: execution.desc.minReturnAmount,
      flags: execution.desc.flags,
      permit: execution.desc.permit,
    },
  };
}

function patchKyber(calldata: string, patch: { dstReceiver?: string; dstToken?: string; srcToken?: string }): string {
  const execution = kyberExecution(calldata);
  execution.desc.dstReceiver = patch.dstReceiver ?? execution.desc.dstReceiver;
  execution.desc.dstToken = patch.dstToken ?? execution.desc.dstToken;
  execution.desc.srcToken = patch.srcToken ?? execution.desc.srcToken;
  return KYBER.encodeFunctionData('swap', [execution]);
}

function leg(callData: string, patch: Partial<Leg> = {}): Leg {
  return {
    callTo: getAddress(KYBER_META_AGGREGATION_ROUTER_V2),
    approveTo: getAddress(KYBER_META_AGGREGATION_ROUTER_V2),
    sendingAssetId: getAddress(fixture.srcToken),
    receivingAssetId: getAddress(fixture.dstToken),
    fromAmount: BigInt(fixture.amount),
    callData,
    requiresDeposit: true,
    ...patch,
  };
}

function encodeSingle(swapLeg: Leg, receiver: string, minOut = BigInt(fixture.minReturnAmount)): string {
  return V3.encodeFunctionData('swapTokensSingleV3ERC20ToERC20', [
    `0x${'11'.repeat(32)}`,
    'evalanche',
    '0x',
    receiver,
    minOut,
    swapLeg,
  ]);
}

function encodeMultiple(legs: Leg[], receiver: string, minOut = BigInt(fixture.minReturnAmount)): string {
  return V3.encodeFunctionData('swapTokensMultipleV3ERC20ToERC20', [
    `0x${'22'.repeat(32)}`,
    'evalanche',
    '0x',
    receiver,
    minOut,
    legs,
  ]);
}

function allowFor(legs: Leg[], receiver: string): AllowEntry[] {
  const by = new Map<string, AllowEntry>();
  const add = (address: string, roles: AllowRole[], selectors: string[] = []) => {
    const key = getAddress(address);
    const existing = by.get(key);
    if (!existing) {
      by.set(key, { address: key, selectors: [...selectors], roles: [...roles], decimals: 6 });
      return;
    }
    for (const role of roles) {
      if (!existing.roles?.includes(role)) existing.roles?.push(role);
    }
    for (const selector of selectors) {
      if (!existing.selectors.includes(selector)) existing.selectors.push(selector);
    }
  };
  add(LIFI_DIAMOND, [], [SELECTOR.swapTokensSingleV3ERC20ToERC20, SELECTOR.swapTokensMultipleV3ERC20ToERC20]);
  add(receiver, ['recipient']);
  for (const item of legs) {
    add(item.callTo, ['dex']);
    add(item.approveTo, ['spender']);
    add(item.sendingAssetId, ['token']);
    add(item.receivingAssetId, ['token']);
  }
  return [...by.values()];
}

function decodeOptions(wallet: string, allow: AllowEntry[], legs: Leg[]): DecodeOptions {
  return {
    wallet,
    value: 0n,
    explicitAllows: new Set(),
    tokenIn: legs[0].sendingAssetId,
    tokenOut: legs[legs.length - 1].receivingAssetId,
    amountIn: legs[0].fromAmount,
    allowAddress: (address) => allow.some((entry) => getAddress(entry.address) === getAddress(address)),
    allowSelector: (to, selector) => {
      const entry = allow.find((item) => getAddress(item.address) === getAddress(to));
      return Boolean(entry?.selectors.includes(selector.toLowerCase()));
    },
    allowRole: (address, role) => {
      const entry = allow.find((item) => getAddress(item.address) === getAddress(address));
      return Boolean(entry?.roles?.includes(role));
    },
  };
}

async function boot(allow: AllowEntry[], extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lifi-kyber-'));
  const verifier = generateEd25519KeyPair();
  const wallet = new Wallet(KEY);
  const server = await startSignerServer({
    privateKey: KEY,
    verifierPublicKey: verifier.publicKey,
    token: 't',
    auditLogPath: join(root, 'a.jsonl'),
    nonceStorePath: join(root, 'n.json'),
    chainId: CHAIN,
    port: 0,
    allow: { [CHAIN]: allow },
    initNonces: true,
    allowInsecureFilePermissions: true,
    simulate: async () => ({ success: true }),
    ...extra,
  });
  servers.push(server);
  return { server, verifier, wallet };
}

async function sign(data: string, legs: Leg[], receiver: string, over: Partial<SigningIntent> = {}, extra: Record<string, unknown> = {}) {
  const allow = allowFor(legs, receiver);
  const harness = await boot(allow, extra);
  const tx: ApprovedTransaction = {
    to: getAddress(LIFI_DIAMOND),
    value: '0',
    data,
    chainId: CHAIN,
    nonce: '0',
    gasLimit: '800000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
  const now = Date.now();
  const built: SigningIntent = {
    version: '1',
    intentId: 'kyber',
    nonce: '1',
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: harness.wallet.address,
    chainId: CHAIN,
    venue: 'avalanche',
    action: 'swap',
    amountIn: legs[0].fromAmount.toString(),
    minAmountOut: fixture.minReturnAmount,
    quotedAmountOut: fixture.minReturnAmount,
    routeHash: computeApprovedTxHash(tx),
    tx,
    tokenIn: { address: legs[0].sendingAssetId, symbol: 'IN', decimals: 6 },
    tokenOut: { address: legs[legs.length - 1].receivingAssetId, symbol: 'OUT', decimals: 6 },
    ...over,
  };
  const approval = signVerifierApproval({
    intent: built,
    verifierPrivateKey: harness.verifier.privateKey,
    verifierPublicKey: harness.verifier.publicKey,
    mode: 'live',
  });
  const request: CanonicalSigningRequest = {
    requestId: 'r',
    kind: 'transaction',
    chainId: tx.chainId,
    from: harness.wallet.address,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: Number(tx.nonce),
    type: tx.type,
    intent: 'kyber',
    structuredIntent: built,
    approval,
  };
  return harness.server.handle(request);
}


export { KYBER, kyberExecution, patchKyber, leg, encodeSingle, encodeMultiple, allowFor, decodeOptions, sign, ATTACKER, KEY };
