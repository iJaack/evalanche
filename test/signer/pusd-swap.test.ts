/**
 * pUSD is a Polygon swap token when the allow map gives it the token role.
 * The swap target is the Li.Fi diamond. Calls to pUSD itself stay on the
 * Polymarket deny list, so an approve selector on that entry does not
 * permit an approval. CollateralOnramp stays denied.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import {
  KYBER_AGGREGATION_EXECUTOR,
  KYBER_META_AGGREGATION_ROUTER_V2,
  LIFI_DIAMOND,
  SELECTOR,
} from '../../src/signer/decode';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import {
  PM_COLLATERAL_ONRAMP,
  PM_CTF_EXCHANGE_V2,
  PM_PUSD,
} from '../../src/signer/polymarket-addresses';
import { POLYGON_NATIVE_USDC } from '../../src/signer/revoke-only';
import type { AllowEntry, EvalancheSignerServer } from '../../src/signer/server';
import fixture from './fixtures/kyber-avalanche-swap.json';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const NO_CODE = '0x794a61358d6845594f3DCa32f21763fB5b21AbDf';
const USDC = getAddress(POLYGON_NATIVE_USDC);
const PUSD = getAddress(PM_PUSD);
const DIAMOND = getAddress(LIFI_DIAMOND);
const ROUTER = getAddress(KYBER_META_AGGREGATION_ROUTER_V2);
const EXECUTOR = getAddress(KYBER_AGGREGATION_EXECUTOR);
const AMOUNT = fixture.amount;
const QUOTE = '1000000';

const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const V3 = new Interface([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
]);
const KYBER = new Interface([
  'function swap((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);
const ERC20 = new Interface(['function approve(address spender, uint256 amount)']);

const servers: EvalancheSignerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function retargetKyber(): string {
  const decoded = KYBER.decodeFunctionData('swap', fixture.calldata);
  const execution = decoded[0];
  const copy = {
    callTarget: execution.callTarget,
    approveTarget: execution.approveTarget,
    targetData: execution.targetData,
    clientData: execution.clientData,
    desc: {
      srcToken: USDC,
      dstToken: PUSD,
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
  return KYBER.encodeFunctionData('swap', [copy]);
}

function swapData(minOut: bigint): string {
  return V3.encodeFunctionData('swapTokensSingleV3ERC20ToERC20', [
    `0x${'11'.repeat(32)}`,
    'evalanche',
    '0x',
    WALLET,
    minOut,
    {
      callTo: ROUTER,
      approveTo: ROUTER,
      sendingAssetId: USDC,
      receivingAssetId: PUSD,
      fromAmount: BigInt(AMOUNT),
      callData: retargetKyber(),
      requiresDeposit: true,
    },
  ]);
}

interface BootOptions {
  pusdSelectors?: string[];
  pusdToken?: boolean;
  stables?: boolean;
  revokeOnly?: boolean;
  polymarket?: boolean;
}

async function boot(options: BootOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pusd-swap-'));
  const verifier = generateEd25519KeyPair();
  const allow: AllowEntry[] = [
    { address: WALLET, selectors: ['0x'], roles: ['recipient'] },
    { address: DIAMOND, selectors: [SELECTOR.swapTokensSingleV3ERC20ToERC20], roles: [] },
    { address: ROUTER, selectors: [], decimals: 18, roles: ['dex', 'spender'] },
    { address: USDC, selectors: [], decimals: 6, roles: ['token'] },
  ];
  if (options.pusdToken !== false) {
    allow.push({
      address: PUSD,
      selectors: options.pusdSelectors ?? [],
      decimals: 6,
      roles: ['token'],
    });
  }
  const tokenCaps: Record<string, string> = {
    native: '1000000000000000000',
    [USDC]: '1000000000',
  };
  if (options.pusdToken !== false) tokenCaps[PUSD] = '1000000000';
  const server = await startSignerServer({
    privateKey: KEY,
    verifierPublicKey: verifier.publicKey,
    token: 't',
    auditLogPath: join(root, 'a.jsonl'),
    nonceStorePath: join(root, 'n.json'),
    initNonces: true,
    allowInsecureFilePermissions: true,
    port: 0,
    simulate: async () => ({ success: true }),
    allow: {
      43114: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      137: allow,
    },
    chains: {
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 1 } },
      },
      137: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps,
        price: { prices: { native: 1, [USDC]: 1, [PUSD]: 1 } },
        kyberExecutors: [EXECUTOR],
        slippageCaps: options.stables === false
          ? { otherBps: 300 }
          : { stables: [PUSD], stableBps: 50, otherBps: 300 },
        revokeOnly: options.revokeOnly ? { enabled: true } : undefined,
        polymarket: options.polymarket
          ? { enabled: true, perOrderPctNav: 1, perMarketPctNav: 1, totalOpenPctNav: 1, maxOrdersPerDay: 1 }
          : undefined,
      },
    },
  });
  servers.push(server);
  return { server, verifier };
}

function tx(to: string, data: string): ApprovedTransaction {
  return {
    to: getAddress(to),
    value: '0',
    data,
    chainId: 137,
    nonce: '0',
    gasLimit: '800000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
}

async function submit(
  h: Awaited<ReturnType<typeof boot>>,
  to: string,
  data: string,
  intentPatch: Partial<SigningIntent> & { nonce: string },
) {
  const approved = tx(to, data);
  const now = Date.now();
  const intent: SigningIntent = {
    version: '1',
    intentId: `pusd-${intentPatch.nonce}`,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId: 137,
    venue: 'lifi-kyber',
    action: 'swap',
    amountIn: AMOUNT,
    minAmountOut: QUOTE,
    quotedAmountOut: QUOTE,
    tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    tokenOut: { address: PUSD, symbol: 'pUSD', decimals: 6 },
    routeHash: computeApprovedTxHash(approved),
    tx: approved,
    ...intentPatch,
  };
  return h.server.handle({
    requestId: intent.intentId,
    kind: 'transaction',
    chainId: 137,
    from: WALLET,
    to: approved.to,
    value: '0',
    data,
    gasLimit: '800000',
    gasPrice: '1',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: intent.action,
    structuredIntent: intent,
    approval: signVerifierApproval({
      intent,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
    }),
  });
}

describe('pUSD as a Polygon swap token', () => {
  it('signs a lifi-kyber swap into pUSD and keeps the stable slippage cap', async () => {
    const h = await boot();
    const signed = await submit(h, DIAMOND, swapData(995_000n), { nonce: '1', minAmountOut: '995000' });
    expect(signed.signedTransaction).toMatch(/^0x/);
    await expect(submit(h, DIAMOND, swapData(970_000n), { nonce: '2', minAmountOut: '970000' })).rejects.toThrow(/quoted slippage floor/);
  });

  it('uses the 300 bps other cap when pUSD is not listed as a stable', async () => {
    const h = await boot({ stables: false });
    const signed = await submit(h, DIAMOND, swapData(970_000n), { nonce: '1', minAmountOut: '970000' });
    expect(signed.signedTransaction).toMatch(/^0x/);
    await expect(submit(h, DIAMOND, swapData(969_999n), { nonce: '2', minAmountOut: '969999' })).rejects.toThrow(/quoted slippage floor/);
  });

  it('refuses the swap when pUSD has no token role, and refuses a polymarket venue', async () => {
    const missing = await boot({ pusdToken: false });
    await expect(submit(missing, DIAMOND, swapData(995_000n), { nonce: '1' })).rejects.toThrow(/not an allowlisted token/);
    await missing.server.close();
    const h = await boot();
    await expect(submit(h, DIAMOND, swapData(995_000n), { nonce: '1', venue: 'polymarket' })).rejects.toThrow(/Polymarket is denied/);
  });

  it('does not approve pUSD from the allow map or from revoke-only', async () => {
    const h = await boot({ pusdSelectors: [SELECTOR.approve], revokeOnly: true });
    const swap = await submit(h, DIAMOND, swapData(995_000n), { nonce: '1', minAmountOut: '995000' });
    expect(swap.signedTransaction).toMatch(/^0x/);
    const toDiamond = ERC20.encodeFunctionData('approve', [DIAMOND, BigInt(AMOUNT)]);
    const toNoCode = ERC20.encodeFunctionData('approve', [NO_CODE, 0n]);
    const toExchange = ERC20.encodeFunctionData('approve', [PM_CTF_EXCHANGE_V2, 0n]);
    await expect(submit(h, PUSD, toDiamond, {
      nonce: '2',
      action: 'approve',
      amountIn: AMOUNT,
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/Polymarket denial/);
    await expect(submit(h, PUSD, toNoCode, {
      nonce: '3',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/Polymarket denial/);
    await expect(submit(h, PUSD, toExchange, {
      nonce: '4',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/Polymarket denial/);
    await expect(submit(h, PM_COLLATERAL_ONRAMP, '0x', {
      nonce: '5',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenIn: { address: PM_COLLATERAL_ONRAMP, symbol: 'ONRAMP', decimals: 6 },
      tokenOut: undefined,
    })).rejects.toThrow(/Polymarket denial/);
  });

  it('allows a zero pUSD approve only through the Polymarket module, to a protocol spender', async () => {
    const h = await boot({ polymarket: true, pusdSelectors: [SELECTOR.approve] });
    const cleared = ERC20.encodeFunctionData('approve', [PM_CTF_EXCHANGE_V2, 0n]);
    const signed = await submit(h, PUSD, cleared, {
      nonce: '1',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    });
    expect(signed.signedTransaction).toMatch(/^0x/);
    const positive = ERC20.encodeFunctionData('approve', [PM_CTF_EXCHANGE_V2, 1n]);
    await expect(submit(h, PUSD, positive, {
      nonce: '2',
      action: 'approve',
      amountIn: '1',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/approvals to Polymarket are denied/);
    const outsider = ERC20.encodeFunctionData('approve', [DIAMOND, 0n]);
    await expect(submit(h, PUSD, outsider, {
      nonce: '3',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenOut: undefined,
    })).rejects.toThrow(/approvals to Polymarket are denied/);
    await expect(submit(h, PM_COLLATERAL_ONRAMP, '0x12345678', {
      nonce: '4',
      action: 'approve',
      amountIn: '0',
      minAmountOut: undefined,
      quotedAmountOut: undefined,
      tokenIn: { address: PM_COLLATERAL_ONRAMP, symbol: 'ONRAMP', decimals: 6 },
      tokenOut: undefined,
    })).rejects.toThrow(/Polymarket denial/);
  });
});
