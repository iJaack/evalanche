/**
 * Regression tests for the verifier bypasses against evalanche-signer.
 *
 * Each case is the reviewer's attack. It must be rejected. On the vulnerable
 * signer these assertions fail because the attack is signed.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, MaxUint256, Transaction, Wallet } from 'ethers';
import {
  canonicalJson,
  computeApprovedTxHash,
  computeIntentHash,
  computeRequestRouteHash,
  computeRouteHash,
  generateEd25519KeyPair,
  signIntentHash,
  signVerifierApproval,
  startSignerServer,
} from '../../src/index';
import type { CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN = 43114;
const ROUTER = '0x000000000000000000000000000000000000bEEF';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

async function boot(extra: Record<string, unknown> = {}, paths?: { audit: string; nonce: string }) {
  const root = await mkdtemp(join(tmpdir(), 'poc-'));
  const p = paths ?? { audit: join(root, 'a.jsonl'), nonce: join(root, 'n.json') };
  const verifier = (extra.verifier as ReturnType<typeof generateEd25519KeyPair> | undefined) ?? generateEd25519KeyPair();
  const wallet = new Wallet(KEY);
  const { verifier: _ignored, initNonces, ...rest } = extra;
  const server = await startSignerServer({
    privateKey: KEY,
    verifierPublicKey: verifier.publicKey,
    token: 't',
    auditLogPath: p.audit,
    nonceStorePath: p.nonce,
    chainId: CHAIN,
    port: 0,
    simulate: async () => ({ success: true }),
    tokenCaps: { native: '1000000000000000000' },
    initNonces: initNonces !== false,
    allow: {
      [CHAIN]: [{ address: ROUTER, selectors: ['0x', '0x095ea7b3', '0xa9059cbb'] }],
    },
    ...rest,
    verifierPublicKey: verifier.publicKey,
  } as never);
  servers.push(server);
  return { server, verifier, wallet, p };
}

function mkIntent(wallet: string, routeHash: string, o: Partial<SigningIntent> = {}): SigningIntent {
  const now = Date.now();
  return {
    version: '1',
    intentId: 'i',
    nonce: '1',
    createdAt: now,
    expiresAt: now + 300_000,
    wallet,
    chainId: CHAIN,
    venue: 'lifi',
    action: 'swap',
    tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    amountIn: '1000000',
    minAmountOut: '1',
    tier: 'T1',
    routeHash,
    ...o,
  };
}

function approve(h: Awaited<ReturnType<typeof boot>>, i: SigningIntent) {
  return signVerifierApproval({
    intent: i,
    verifierPrivateKey: h.verifier.privateKey,
    verifierPublicKey: h.verifier.publicKey,
  });
}

describe('PoC regressions', () => {
  it('P1: to/value/gas are not bound by the approval', async () => {
    const h = await boot();
    const data = '0xabcdef01';
    const i = mkIntent(h.wallet.address, computeRouteHash(data));
    const evil: CanonicalSigningRequest = {
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: ATTACKER,
      value: '1000000000000000000',
      data,
      gasLimit: '30000000',
      gasPrice: '100000000000000',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: approve(h, i),
    };
    await expect(h.server.handle(evil)).rejects.toThrow(/match|bound|allow|gas|denied|selector/i);
    expect(evil.to).toBe(ATTACKER);
  });

  it('P1b: empty-calldata approval cannot become a native send to any address', async () => {
    const h = await boot();
    const i = mkIntent(h.wallet.address, computeRouteHash('0x'), { venue: 'avalanche', action: 'transfer', minAmountOut: undefined });
    await expect(h.server.handle({
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: ATTACKER,
      value: '1000000000000000000',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: approve(h, i),
    })).rejects.toThrow(/match|bound|allow|denied/i);
  });

  it('P2: approve calldata re-pointed at a different token is denied', async () => {
    const h = await boot();
    const data = new Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [ROUTER, 1000000n]);
    const i = mkIntent(h.wallet.address, computeRouteHash(data), { action: 'approve' });
    await expect(h.server.handle({
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: WAVAX,
      value: '0',
      data,
      gasLimit: '60000',
      gasPrice: '1',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: approve(h, i),
    })).rejects.toThrow(/match|token|allow|denied|selector/i);
  });

  it('P3: Hyperliquid typed data is denied when labelled as something else', async () => {
    const h = await boot();
    const typedData = {
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      value: { source: 'a', connectionId: `0x${'11'.repeat(32)}` },
    };
    const req = { requestId: 'r', kind: 'typed-data' as const, chainId: CHAIN, from: h.wallet.address, intent: 'x', typedData };
    const i = mkIntent(h.wallet.address, computeRequestRouteHash(req), { venue: 'avalanche', action: 'swap' });
    await expect(h.server.handle({ ...req, structuredIntent: i, approval: approve(h, i) })).rejects.toThrow(/hyperliquid|denied|typed/i);
  });

  it('P3b: Hyperliquid approveAgent is denied by its domain', async () => {
    const h = await boot();
    const typedData = {
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 42161, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: {
        'HyperliquidTransaction:ApproveAgent': [
          { name: 'hyperliquidChain', type: 'string' },
          { name: 'agentAddress', type: 'address' },
          { name: 'agentName', type: 'string' },
          { name: 'nonce', type: 'uint64' },
        ],
      },
      value: { hyperliquidChain: 'Mainnet', agentAddress: ATTACKER, agentName: 'x', nonce: 1 },
    };
    const req = { requestId: 'r', kind: 'typed-data' as const, chainId: CHAIN, from: h.wallet.address, intent: 'x', typedData };
    const i = mkIntent(h.wallet.address, computeRequestRouteHash(req), { venue: 'hyperliquid', action: 'approveAgent' });
    await expect(h.server.handle({ ...req, structuredIntent: i, approval: approve(h, i) })).rejects.toThrow(/hyperliquid|denied|typed/i);
  });

  it('P4: unlimited EIP-2612 permit is denied', async () => {
    const h = await boot();
    const typedData = {
      domain: { name: 'USD Coin', version: '2', chainId: CHAIN, verifyingContract: USDC },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      value: {
        owner: h.wallet.address,
        spender: ATTACKER,
        value: MaxUint256.toString(),
        nonce: '0',
        deadline: MaxUint256.toString(),
      },
    };
    const req = { requestId: 'r', kind: 'typed-data' as const, chainId: CHAIN, from: h.wallet.address, intent: 'x', typedData };
    const i = mkIntent(h.wallet.address, computeRequestRouteHash(req), { action: 'permit' });
    await expect(h.server.handle({ ...req, structuredIntent: i, approval: approve(h, i) })).rejects.toThrow(/permit|denied|typed/i);
  });

  it('P5: a one-year expiry and a future createdAt are denied', async () => {
    const h = await boot();
    const i = mkIntent(h.wallet.address, computeRouteHash('0x'), {
      action: 'transfer',
      createdAt: Date.now() + 86_400_000,
      expiresAt: Date.now() + 365 * 86_400_000,
    });
    await expect(h.server.handle({
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: ROUTER,
      value: '0',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: approve(h, i),
    })).rejects.toThrow(/createdAt|expir|lifetime/i);
  });

  it('P6: dry-run consumes the nonce so the same approval cannot sign after go-live', async () => {
    const dry = await boot({ dryRun: true });
    const tx = {
      to: ROUTER,
      value: '0',
      data: '0x',
      chainId: CHAIN,
      nonce: '0',
      gasLimit: '21000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type: 0,
    };
    const i = mkIntent(dry.wallet.address, computeApprovedTxHash(tx), {
      action: 'transfer',
      venue: 'avalanche',
      minAmountOut: undefined,
      amountIn: '0',
      tx,
    });
    const approval = signVerifierApproval({
      intent: i,
      verifierPrivateKey: dry.verifier.privateKey,
      verifierPublicKey: dry.verifier.publicKey,
      mode: 'dry-run',
    });
    const req: CanonicalSigningRequest = {
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: dry.wallet.address,
      to: ROUTER,
      value: '0',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval,
    };
    const first = await dry.server.handle(req);
    expect(first.dryRun).toBe(true);
    expect(first.signedTransaction).toBeUndefined();
    await expect(dry.server.handle(req)).rejects.toThrow(/replayed nonce/i);
    await dry.server.close();
    servers.pop();
    const live = await boot({ verifier: dry.verifier, initNonces: false }, dry.p);
    await expect(live.server.handle(req)).rejects.toThrow(/replayed nonce|mode/i);
  });

  it('P7: a signature over the raw intent hash is not an approval', async () => {
    const h = await boot();
    const i = mkIntent(h.wallet.address, computeRouteHash('0x'), { action: 'transfer' });
    const intentHash = computeIntentHash(i);
    const denySig = signIntentHash(intentHash, h.verifier.privateKey, h.verifier.publicKey);
    await expect(h.server.handle({
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: ROUTER,
      value: '0',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: {
        intentHash,
        nonce: i.nonce,
        expiresAt: i.expiresAt,
        verifier: h.verifier.publicKey,
        signature: denySig,
        decision: 'deny',
      },
    })).rejects.toThrow(/signature|decision|approval/i);
  });

  it('P8: message "x" and message "0x78" do not share a routeHash', () => {
    const a = computeRequestRouteHash({ kind: 'message', message: 'x' });
    const b = computeRequestRouteHash({ kind: 'message', message: '0x78' });
    expect(a).not.toBe(b);
  });

  it('P9: __proto__ and a numeric nonce are rejected', () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"z":1}}');
    expect(() => canonicalJson(parsed)).toThrow(/__proto__|forbidden/i);
    const i = mkIntent(ATTACKER, `0x${'ab'.repeat(32)}`);
    expect(() => computeIntentHash({ ...i, nonce: 1 } as unknown as SigningIntent)).toThrow(/nonce/);
    expect(() => canonicalJson(JSON.parse('{"constructor":{"x":1}}'))).toThrow(/constructor|forbidden/i);
  });

  it('P10: wiping the nonce file to {} does not silently reset history', async () => {
    const h = await boot();
    const tx = {
      to: ROUTER,
      value: '0',
      data: '0x',
      chainId: CHAIN,
      nonce: '0',
      gasLimit: '21000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type: 0,
    };
    const i = mkIntent(h.wallet.address, computeApprovedTxHash(tx), {
      action: 'transfer',
      venue: 'avalanche',
      minAmountOut: undefined,
      amountIn: '0',
      tx,
    });
    const req: CanonicalSigningRequest = {
      requestId: 'r',
      kind: 'transaction',
      chainId: CHAIN,
      from: h.wallet.address,
      to: ROUTER,
      value: '0',
      data: '0x',
      gasLimit: '21000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'x',
      structuredIntent: i,
      approval: approve(h, i),
    };
    await h.server.handle(req);
    await h.server.close();
    servers.pop();
    await writeFile(h.p.nonce, '{}');
    await expect(boot({ verifier: h.verifier, initNonces: false }, h.p)).rejects.toThrow(/init-nonces|empty|nonce store/i);
  });
});

void Transaction;
