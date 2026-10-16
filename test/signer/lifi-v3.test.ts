/**
 * Avalanche Li.Fi V3. The diamond's facet lookup returns the zero address for
 * swapTokensGeneric (0x4630a0d8). Live routes use GenericSwapFacetV3.
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
  LIFI_DIAMOND,
  LIFI_GENERIC_SWAP_FACET_V3,
  SELECTOR,
  decodeCalldata,
  type AllowRole,
  type DecodeOptions,
} from '../../src/signer/decode';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';
import type { AllowEntry } from '../../src/signer/server';
import fixture from './fixtures/lifi-v3-avalanche.json';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN = 43114;
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const OTHER = '0x000000000000000000000000000000000000bEEF';
const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const V3 = new Interface([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG}[] swapData)`,
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

interface ParsedSwap {
  name: 'swapTokensSingleV3ERC20ToERC20' | 'swapTokensMultipleV3ERC20ToERC20';
  selector: string;
  transactionId: string;
  integrator: string;
  referrer: string;
  receiver: string;
  minOut: bigint;
  legs: Leg[];
  input: string;
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

function parse(input: string): ParsedSwap {
  const selector = input.slice(0, 10).toLowerCase();
  const name = selector === SELECTOR.swapTokensSingleV3ERC20ToERC20
    ? 'swapTokensSingleV3ERC20ToERC20'
    : 'swapTokensMultipleV3ERC20ToERC20';
  const decoded = V3.decodeFunctionData(name, input);
  const raw = name === 'swapTokensSingleV3ERC20ToERC20' ? [decoded.swapData] : decoded.swapData;
  return {
    name,
    selector,
    transactionId: String(decoded.transactionId),
    integrator: String(decoded.integrator),
    referrer: String(decoded.referrer),
    receiver: getAddress(String(decoded.receiver)),
    minOut: BigInt(decoded.minAmountOut),
    input,
    legs: [...raw].map((leg) => ({
      callTo: getAddress(String(leg.callTo)),
      approveTo: getAddress(String(leg.approveTo)),
      sendingAssetId: getAddress(String(leg.sendingAssetId)),
      receivingAssetId: getAddress(String(leg.receivingAssetId)),
      fromAmount: BigInt(leg.fromAmount),
      callData: String(leg.callData),
      requiresDeposit: Boolean(leg.requiresDeposit),
    })),
  };
}

function encode(swap: ParsedSwap, patch: { receiver?: string; minOut?: bigint; leg?: number; callTo?: string; approveTo?: string } = {}): string {
  const legs = swap.legs.map((leg, index) => ({
    ...leg,
    callTo: patch.leg === index && patch.callTo ? patch.callTo : leg.callTo,
    approveTo: patch.leg === index && patch.approveTo ? patch.approveTo : leg.approveTo,
  }));
  return V3.encodeFunctionData(swap.name, [
    swap.transactionId,
    swap.integrator,
    swap.referrer,
    patch.receiver ?? swap.receiver,
    patch.minOut ?? swap.minOut,
    swap.name === 'swapTokensSingleV3ERC20ToERC20' ? legs[0] : legs,
  ]);
}

function allowFor(swap: ParsedSwap, extra: AllowEntry[] = []): AllowEntry[] {
  const by = new Map<string, AllowEntry>();
  const add = (address: string, roles: AllowRole[], selectors: string[] = []) => {
    const key = getAddress(address);
    const existing = by.get(key);
    if (!existing) {
      by.set(key, { address: key, selectors: [...selectors], roles: [...roles], decimals: 18 });
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
  for (const leg of swap.legs) {
    add(leg.callTo, ['dex']);
    add(leg.approveTo, ['spender']);
    add(leg.sendingAssetId, ['token']);
    add(leg.receivingAssetId, ['token']);
  }
  for (const entry of extra) add(entry.address, entry.roles ?? [], entry.selectors);
  return [...by.values()];
}

function decodeOptions(swap: ParsedSwap, wallet: string, allow: AllowEntry[]): DecodeOptions {
  return {
    wallet,
    value: 0n,
    explicitAllows: new Set(),
    tokenIn: swap.legs[0].sendingAssetId,
    tokenOut: swap.legs[swap.legs.length - 1].receivingAssetId,
    amountIn: swap.legs[0].fromAmount,
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
  const root = await mkdtemp(join(tmpdir(), 'lifi-v3-'));
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

function txFields(data: string, nonce = '0'): ApprovedTransaction {
  return {
    to: getAddress(LIFI_DIAMOND),
    value: '0',
    data,
    chainId: CHAIN,
    nonce,
    gasLimit: '800000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
}

function intentFor(wallet: string, swap: ParsedSwap, data: string, overrides: Partial<SigningIntent> = {}): SigningIntent {
  const tx = txFields(data, overrides.nonce ?? '0');
  const now = Date.now();
  const first = swap.legs[0];
  const last = swap.legs[swap.legs.length - 1];
  return {
    version: '1',
    intentId: 'i',
    nonce: '1',
    createdAt: now,
    expiresAt: now + 60_000,
    wallet,
    chainId: CHAIN,
    venue: 'avalanche',
    action: 'swap',
    amountIn: first.fromAmount.toString(),
    minAmountOut: swap.minOut.toString(),
    routeHash: computeApprovedTxHash(tx),
    tx,
    tokenIn: { address: first.sendingAssetId, symbol: 'IN', decimals: 18 },
    tokenOut: { address: last.receivingAssetId, symbol: 'OUT', decimals: 18 },
    ...overrides,
    wallet,
    tx: overrides.tx ?? tx,
  };
}

function requestFor(wallet: string, built: SigningIntent, approval: ReturnType<typeof signVerifierApproval>): CanonicalSigningRequest {
  const tx = built.tx!;
  return {
    requestId: 'r',
    kind: 'transaction',
    chainId: tx.chainId,
    from: wallet,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: Number(tx.nonce),
    type: tx.type,
    intent: 'bounded',
    structuredIntent: built,
    approval,
  };
}

async function sign(swap: ParsedSwap, data: string, allow: AllowEntry[], extra: Record<string, unknown> = {}, overrides: Partial<SigningIntent> = {}) {
  const harness = await boot(allow, extra);
  const built = intentFor(harness.wallet.address, swap, data, overrides);
  const approval = signVerifierApproval({
    intent: built,
    verifierPrivateKey: harness.verifier.privateKey,
    verifierPublicKey: harness.verifier.publicKey,
    mode: 'live',
  });
  return harness.server.handle(requestFor(harness.wallet.address, built, approval));
}

const single = parse(fixture.single.input);
const multiple = parse(fixture.multiple.input);

describe('Avalanche Li.Fi V3', () => {
  it('uses the on-chain GenericSwapFacetV3 address and the real selectors', () => {
    expect(fixture.chainId).toBe(CHAIN);
    expect(getAddress(fixture.diamond)).toBe(LIFI_DIAMOND);
    expect(getAddress(fixture.facet)).toBe(LIFI_GENERIC_SWAP_FACET_V3);
    expect(fixture.single.selector).toBe(SELECTOR.swapTokensSingleV3ERC20ToERC20);
    expect(fixture.multiple.selector).toBe(SELECTOR.swapTokensMultipleV3ERC20ToERC20);
    expect(fixture.single.hash).toBe('0x7521b53433ab897db2143bb72aeae3cfc2c3ffe3602cb7b64c6e11aec5c4899e');
    expect(fixture.multiple.hash).toBe('0xe67a5c762819f878b80644f149e2de28ddb7054687adb31cb84877837a120f15');
    expect(V3.getFunction('swapTokensSingleV3ERC20ToERC20')!.selector).toBe(SELECTOR.swapTokensSingleV3ERC20ToERC20);
    expect(V3.getFunction('swapTokensMultipleV3ERC20ToERC20')!.selector).toBe(SELECTOR.swapTokensMultipleV3ERC20ToERC20);
  });

  it('decodes every leg of the real single and multiple calldata', () => {
    expect(encode(single)).toBe(single.input);
    expect(encode(multiple)).toBe(multiple.input);
    expect(single.legs).toHaveLength(1);
    expect(multiple.legs).toHaveLength(2);
    expect(multiple.legs[0].requiresDeposit).toBe(true);
    expect(multiple.legs[1].requiresDeposit).toBe(false);
    expect(multiple.legs[0].receivingAssetId).toBe(multiple.legs[1].sendingAssetId);
    expect(multiple.legs[1].approveTo).not.toBe(multiple.legs[1].callTo);

    for (const swap of [single, multiple]) {
      const allow = allowFor(swap, [{ address: swap.receiver, selectors: [], roles: ['recipient'] }]);
      const [call] = decodeCalldata(LIFI_DIAMOND, swap.input, decodeOptions(swap, swap.receiver, allow));
      expect(call.kind).toBe('lifi-swap');
      expect(call.selector).toBe(swap.selector);
      expect(call.receiver).toBe(swap.receiver);
      expect(call.minOut).toBe(swap.minOut);
      expect(call.amount).toBe(swap.legs[0].fromAmount);
      expect(call.asset).toBe(swap.legs[0].sendingAssetId);
    }
  });

  it('signs real calldata once the receiver is the signer wallet', async () => {
    for (const swap of [single, multiple]) {
      const data = encode(swap, { receiver: new Wallet(KEY).address });
      const allow = allowFor(swap, [{ address: new Wallet(KEY).address, selectors: [], roles: ['recipient'] }]);
      const signed = await sign(swap, data, allow);
      expect(signed.signedTransaction).toMatch(/^0x/);
    }
  });

  it('prices the cap on the sold asset and ignores later legs', async () => {
    const wallet = new Wallet(KEY).address;
    const data = encode(multiple, { receiver: wallet });
    const allow = allowFor(multiple, [{ address: wallet, selectors: [], roles: ['recipient'] }]);
    const sold = multiple.legs[0].sendingAssetId.toLowerCase();
    const exact = await sign(multiple, data, allow, { tokenCaps: { [sold]: multiple.legs[0].fromAmount.toString() } });
    expect(exact.signedTransaction).toMatch(/^0x/);
    await expect(sign(multiple, data, allow, {
      tokenCaps: { [sold]: (multiple.legs[0].fromAmount - 1n).toString() },
    })).rejects.toThrow(/oversize/i);
  });

  it('denies an unlisted dex in a leg', async () => {
    const wallet = new Wallet(KEY).address;
    const data = encode(multiple, { receiver: wallet, leg: 1, callTo: ATTACKER });
    const allow = allowFor(multiple, [{ address: wallet, selectors: [], roles: ['recipient'] }]);
    await expect(sign(multiple, data, allow)).rejects.toThrow(/callTo is not allowlisted/i);
  });

  it('denies an unlisted approve spender in a leg', async () => {
    const wallet = new Wallet(KEY).address;
    const data = encode(multiple, { receiver: wallet, leg: 1, approveTo: ATTACKER });
    const allow = allowFor(multiple, [{ address: wallet, selectors: [], roles: ['recipient'] }]);
    await expect(sign(multiple, data, allow)).rejects.toThrow(/approveTo is not allowlisted/i);
  });

  it('denies a wrong receiver even when that address has the recipient role', async () => {
    const allow = allowFor(single, [{ address: single.receiver, selectors: [], roles: ['recipient'] }]);
    await expect(sign(single, single.input, allow)).rejects.toThrow(/not the signer wallet/i);
  });

  it('denies a V3 receiver that lacks the recipient role', async () => {
    const wallet = new Wallet(KEY).address;
    const data = encode(single, { receiver: wallet });
    await expect(sign(single, data, allowFor(single))).rejects.toThrow(/recipient/i);
  });

  it('denies a tampered minOut below the intent bound', async () => {
    const wallet = new Wallet(KEY).address;
    const data = encode(single, { receiver: wallet, minOut: 1n });
    const allow = allowFor(single, [{ address: wallet, selectors: [], roles: ['recipient'] }]);
    await expect(sign(single, data, allow)).rejects.toThrow(/minOut/i);
  });

  it('denies an unknown selector, including a native V3 selector, when the diamond allowlists it', async () => {
    const wallet = new Wallet(KEY).address;
    const allow = allowFor(single, [{ address: wallet, selectors: [], roles: ['recipient'] }]);
    const diamond = allow.find((entry) => getAddress(entry.address) === LIFI_DIAMOND);
    diamond?.selectors.push('0xdeadbeef', '0xaf7060fd');
    await expect(sign(single, '0xdeadbeef', allow, {}, {
      action: 'call',
      amountIn: '0',
      minAmountOut: undefined,
      tokenIn: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/unknown selector/i);
    await expect(sign(single, '0xaf7060fd', allow, {}, {
      action: 'call',
      amountIn: '0',
      minAmountOut: undefined,
      tokenIn: undefined,
      tokenOut: undefined,
      nonce: '1',
    })).rejects.toThrow(/unknown selector/i);
  });
});
