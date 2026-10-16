/**
 * Negative tests for the signer review: M1–M10 and the should-fix list.
 * The PoC file covers the original bypass payloads. This file covers the
 * cases those payloads do not reach.
 */
import { mkdtemp, readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress, getBytes, verifyMessage } from 'ethers';
import {
  AUDIT_ROOT,
  EvalancheErrorCode,
  canonicalJson,
  computeApprovedTxHash,
  computeIntentHash,
  computeMessageRouteHash,
  generateEd25519KeyPair,
  signIntentHash,
  signVerifierApproval,
  startSignerServer,
} from '../../src/index';
import { NATIVE_ADDRESS, POLYMARKET_DENY_CONTRACTS, SAVAX_CONTRACT } from '../../src/signer/decode';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';
import type { AllowEntry, EvalancheSignerServer } from '../../src/signer/server';
import type { PendingTransaction } from '../../src/economy/types';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN = 43114;
const ROUTER = '0x000000000000000000000000000000000000bEEF';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

const ALLOW: Record<string, AllowEntry[]> = {
  [CHAIN]: [
    { address: ROUTER, selectors: ['0x', '0x6e553f65', '0x4630a0d8', '0xac9650d8', '0x39509351'], decimals: 18 },
    { address: USDC, selectors: ['0xa9059cbb', '0x095ea7b3', '0x39509351', '0xdeadbeef'], decimals: 6 },
    { address: SAVAX_CONTRACT, selectors: ['0xfbc3b807', '0x5bcb2fc6'], decimals: 18 },
    { address: POLYMARKET_DENY_CONTRACTS[0], selectors: ['0x'], decimals: 6 },
  ],
};

async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'harden-'));
  return { root, audit: join(root, 'a.jsonl'), nonce: join(root, 'n.json') };
}

async function boot(extra: Record<string, unknown> = {}) {
  const p = (extra.paths as { audit: string; nonce: string } | undefined) ?? await paths();
  const verifier = (extra.verifier as ReturnType<typeof generateEd25519KeyPair> | undefined) ?? generateEd25519KeyPair();
  const wallet = new Wallet(KEY);
  const { paths: _paths, verifier: _verifier, ...rest } = extra;
  const server = await startSignerServer({
    privateKey: KEY,
    verifierPublicKey: verifier.publicKey,
    token: 't',
    auditLogPath: p.audit,
    nonceStorePath: p.nonce,
    chainId: CHAIN,
    port: 0,
    allow: ALLOW,
    initNonces: true,
    simulate: async () => ({ success: true }),
    ...rest,
    verifierPublicKey: verifier.publicKey,
  });
  servers.push(server);
  return { server, verifier, wallet, p };
}

function txFields(overrides: Partial<ApprovedTransaction> = {}): ApprovedTransaction {
  return {
    to: getAddress(ROUTER),
    value: '0',
    data: '0x',
    chainId: CHAIN,
    nonce: '0',
    gasLimit: '21000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
    ...overrides,
  };
}

function intent(wallet: string, tx: ApprovedTransaction, overrides: Partial<SigningIntent> = {}): SigningIntent {
  const now = Date.now();
  return {
    version: '1',
    intentId: 'i',
    nonce: '1',
    createdAt: now,
    expiresAt: now + 60_000,
    wallet,
    chainId: CHAIN,
    venue: 'avalanche',
    action: 'send',
    amountIn: tx.value,
    routeHash: computeApprovedTxHash(tx),
    tx,
    ...overrides,
    wallet,
  };
}

function request(wallet: string, built: SigningIntent, approval: ReturnType<typeof signVerifierApproval>, overrides: Partial<CanonicalSigningRequest> = {}): CanonicalSigningRequest {
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
    ...overrides,
  };
}

function approvalFor(h: Awaited<ReturnType<typeof boot>>, built: SigningIntent, mode: 'live' | 'dry-run' = 'live') {
  return signVerifierApproval({
    intent: built,
    verifierPrivateKey: h.verifier.privateKey,
    verifierPublicKey: h.verifier.publicKey,
    mode,
  });
}

describe('signer hardening', () => {
  it('M1 rejects a gas field that differs from the approved transaction and a gas cost above the hard cap', async () => {
    const h = await boot();
    const tx = txFields();
    const built = intent(h.wallet.address, tx);
    const approved = approvalFor(h, built);
    await expect(h.server.handle(request(h.wallet.address, built, approved, { gasLimit: '30000000' }))).rejects.toThrow(/gasLimit/);

    const huge = txFields({ gasLimit: '30000000', gasPrice: '100000000000000' });
    const fat = intent(h.wallet.address, huge, { nonce: '2' });
    await expect(h.server.handle(request(h.wallet.address, fat, approvalFor(h, fat)))).rejects.toThrow(/gas cost exceeds the hard cap/i);
  });

  it('M2 denies an allowlisted unknown selector, a redirected receiver, and a low minOut', async () => {
    const h = await boot();
    const unknown = txFields({ to: getAddress(USDC), data: '0xdeadbeef', value: '0' });
    const unknownIntent = intent(h.wallet.address, unknown, { action: 'call', amountIn: '0', tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 } });
    await expect(h.server.handle(request(h.wallet.address, unknownIntent, approvalFor(h, unknownIntent)))).rejects.toThrow(/unknown selector/i);

    const deposit = new Interface(['function deposit(uint256,address)']).encodeFunctionData('deposit', [1000n, ATTACKER]);
    const deposited = txFields({ data: deposit, value: '0' });
    const depositIntent = intent(h.wallet.address, deposited, { action: 'deposit', amountIn: '1000', nonce: '2' });
    await expect(h.server.handle(request(h.wallet.address, depositIntent, approvalFor(h, depositIntent)))).rejects.toThrow(/receiver/i);

    const lifi = new Interface([
      'function swapTokensGeneric(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])',
    ]);
    const swapData = lifi.encodeFunctionData('swapTokensGeneric', [
      `0x${'22'.repeat(32)}`,
      'evalanche',
      'ops',
      h.wallet.address,
      1n,
      [[ROUTER, ROUTER, USDC, USDC, 1000n, '0x', false]],
    ]);
    const swapTx = txFields({ data: swapData });
    const swapIntent = intent(h.wallet.address, swapTx, { action: 'swap', amountIn: '1000', minAmountOut: '5', nonce: '3' });
    await expect(h.server.handle(request(h.wallet.address, swapIntent, approvalFor(h, swapIntent)))).rejects.toThrow(/minOut/i);
  });

  it('M2 prices and caps follow the decoded amount, not a smaller self-reported amount', async () => {
    const h = await boot({ tokenCaps: { [getAddress(USDC).toLowerCase()]: '10' } });
    const transfer = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [ATTACKER, 1000n]);
    const tx = txFields({ to: getAddress(USDC), data: transfer, value: '0' });
    const built = intent(h.wallet.address, tx, {
      action: 'transfer',
      amountIn: '1',
      tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    });
    await expect(h.server.handle(request(h.wallet.address, built, approvalFor(h, built)))).rejects.toThrow(/does not equal amountIn/i);
  });

  it('M3 refuses to start without an allow map and keeps sAVAX instant unstake and Polymarket denied', async () => {
    const p = await paths();
    const verifier = generateEd25519KeyPair();
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      port: 0,
      allow: {},
      initNonces: true,
    })).rejects.toThrow(/allow map/i);

    const h = await boot();
    const instant = new Interface(['function redeemInstant(uint256,uint256)']).encodeFunctionData('redeemInstant', [1n, 1n]);
    const instantTx = txFields({ to: getAddress(SAVAX_CONTRACT), data: instant, value: '0' });
    const instantIntent = intent(h.wallet.address, instantTx, { action: 'unstake', amountIn: '1' });
    await expect(h.server.handle(request(h.wallet.address, instantIntent, approvalFor(h, instantIntent)))).rejects.toThrow(/sAVAX instant unstake/i);

    const poly = txFields({ to: getAddress(POLYMARKET_DENY_CONTRACTS[0]), value: '0' });
    const polyIntent = intent(h.wallet.address, poly, { venue: 'polymarket', action: 'transfer', amountIn: '0', nonce: '2' });
    await expect(h.server.handle(request(h.wallet.address, polyIntent, approvalFor(h, polyIntent)))).rejects.toThrow(/Polymarket/i);
  });

  it('M4 denies Hyperliquid agent types even when the domain name is relabelled', async () => {
    const h = await boot();
    const typedData = {
      domain: { name: 'NotExchange', version: '1', chainId: 1, verifyingContract: ROUTER },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      value: { source: 'a', connectionId: `0x${'ab'.repeat(32)}` },
    };
    const built = intent(h.wallet.address, txFields(), {
      action: 'note',
      venue: 'spot',
      routeHash: `0x${'11'.repeat(32)}`,
      tx: undefined,
    });
    const route = (await import('../../src/signer/intent')).computeTypedDataRouteHash(typedData);
    built.routeHash = route;
    delete built.tx;
    const approval = approvalFor(h, built);
    await expect(h.server.handle({
      requestId: 'hl',
      kind: 'typed-data',
      chainId: CHAIN,
      from: h.wallet.address,
      intent: 'relabelled',
      typedData,
      structuredIntent: built,
      approval,
    })).rejects.toThrow(/Hyperliquid/i);
  });

  it('M5 keeps message and typed-data signing off, and denies Permit and increaseAllowance unless explicitly allowed', async () => {
    const h = await boot();
    const message = 'hello';
    const built = intent(h.wallet.address, txFields(), {
      action: 'sign-message',
      routeHash: computeMessageRouteHash(message),
      tx: undefined,
      amountIn: undefined,
    });
    delete built.tx;
    await expect(h.server.handle({
      requestId: 'm',
      kind: 'message',
      chainId: CHAIN,
      from: h.wallet.address,
      intent: 'sign',
      message,
      structuredIntent: built,
      approval: approvalFor(h, built),
    })).rejects.toThrow(/message signing is disabled/i);

    const increase = new Interface(['function increaseAllowance(address,uint256)']).encodeFunctionData('increaseAllowance', [ATTACKER, 5n]);
    const incTx = txFields({ to: getAddress(USDC), data: increase, value: '0' });
    const incIntent = intent(h.wallet.address, incTx, {
      nonce: '2',
      action: 'approve',
      amountIn: '5',
      tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    });
    await expect(h.server.handle(request(h.wallet.address, incIntent, approvalFor(h, incIntent)))).rejects.toThrow(/increaseAllowance/i);

    const opted = await boot({ explicitAllows: ['increaseAllowance'], messageAllowlist: ['hello'] });
    const okIntent = intent(opted.wallet.address, incTx, {
      action: 'approve',
      amountIn: '5',
      tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    });
    const signed = await opted.server.handle(request(opted.wallet.address, okIntent, approvalFor(opted, okIntent)));
    expect(signed.signedTransaction).toMatch(/^0x/);

    const typedData = {
      domain: { name: 'USD Coin', version: '2', chainId: CHAIN, verifyingContract: USDC },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      value: { owner: h.wallet.address, spender: ATTACKER, value: '1', nonce: '0', deadline: '1' },
    };
    const permitIntent = intent(h.wallet.address, txFields(), { nonce: '4', action: 'permit', tx: undefined, amountIn: undefined });
    delete permitIntent.tx;
    permitIntent.routeHash = (await import('../../src/signer/intent')).computeTypedDataRouteHash(typedData);
    await expect(h.server.handle({
      requestId: 'p',
      kind: 'typed-data',
      chainId: CHAIN,
      from: h.wallet.address,
      intent: 'permit',
      typedData,
      structuredIntent: permitIntent,
      approval: approvalFor(h, permitIntent),
    })).rejects.toThrow(/Permit/i);

    const permit2 = {
      domain: { name: 'Permit2', chainId: CHAIN, verifyingContract: USDC },
      types: { PermitSingle: [{ name: 'details', type: 'string' }] },
      value: { details: 'unlimited' },
    };
    const permit2Intent = intent(h.wallet.address, txFields(), { nonce: '5', action: 'permit2', tx: undefined, amountIn: '1' });
    delete permit2Intent.tx;
    permit2Intent.routeHash = (await import('../../src/signer/intent')).computeTypedDataRouteHash(permit2);
    await expect(h.server.handle({
      requestId: 'p2',
      kind: 'typed-data',
      chainId: CHAIN,
      from: h.wallet.address,
      intent: 'permit2',
      typedData: permit2,
      structuredIntent: permit2Intent,
      approval: approvalFor(h, permit2Intent),
    })).rejects.toThrow(/Permit2/i);

    const allowedPermit = await boot({
      explicitAllows: ['permit'],
      typedDataAllow: [{ domainName: 'USD Coin', primaryType: 'Permit', chainId: CHAIN, verifyingContract: USDC }],
    });
    const unlimited = { ...typedData, value: { ...typedData.value, value: (1n << 256n).toString() } };
    const unlimitedIntent = intent(allowedPermit.wallet.address, txFields(), { action: 'permit', amountIn: (1n << 256n).toString(), tx: undefined });
    delete unlimitedIntent.tx;
    unlimitedIntent.routeHash = (await import('../../src/signer/intent')).computeTypedDataRouteHash(unlimited);
    await expect(allowedPermit.server.handle({
      requestId: 'pu',
      kind: 'typed-data',
      chainId: CHAIN,
      from: allowedPermit.wallet.address,
      intent: 'permit',
      typedData: unlimited,
      structuredIntent: unlimitedIntent,
      approval: approvalFor(allowedPermit, unlimitedIntent),
    })).rejects.toThrow(/[Uu]nlimited|could not be decoded/i);
  });

  it('M6 rejects a deny decision and a raw intent-hash signature presented as approve', async () => {
    const h = await boot();
    const built = intent(h.wallet.address, txFields());
    const deny = signVerifierApproval({
      intent: built,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
      decision: 'deny',
    });
    await expect(h.server.handle(request(h.wallet.address, built, deny))).rejects.toThrow(/decision/i);

    const hash = computeIntentHash(built);
    const raw = signIntentHash(hash, h.verifier.privateKey, h.verifier.publicKey);
    await expect(h.server.handle(request(h.wallet.address, built, {
      ...approvalFor(h, built),
      signature: raw,
    }))).rejects.toThrow(/signature/i);
  });

  it('M7 rejects an approval window longer than 600000ms', async () => {
    const h = await boot();
    const now = Date.now();
    const built = intent(h.wallet.address, txFields(), { createdAt: now, expiresAt: now + 600_001 });
    await expect(h.server.handle(request(h.wallet.address, built, approvalFor(h, built)))).rejects.toThrow(/600000/);
  });

  it('M8 rejects a live approval presented to a dry-run signer', async () => {
    const h = await boot({ dryRun: true });
    const built = intent(h.wallet.address, txFields());
    await expect(h.server.handle(request(h.wallet.address, built, approvalFor(h, built, 'live')))).rejects.toThrow(/mode/i);
  });

  it('M9 requires init, locks the store, and rejects approvals created before state start', async () => {
    const p = await paths();
    const verifier = generateEd25519KeyPair();
    const common = {
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      port: 0,
      allow: ALLOW,
    };
    await expect(startSignerServer(common)).rejects.toThrow(/init-nonces/i);
    await writeFile(p.nonce, '{}');
    await expect(startSignerServer(common)).rejects.toThrow(/init-nonces|empty/i);

    const first = await startSignerServer({ ...common, initNonces: true });
    servers.push(first);
    const secondPaths = await paths();
    await expect(startSignerServer({
      ...common,
      auditLogPath: secondPaths.audit,
      initNonces: true,
    })).rejects.toThrow(/locked/i);

    const built = intent(first.address, txFields(), { createdAt: first.stateStartedAt - 1_000, expiresAt: first.stateStartedAt + 60_000 });
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: verifier.privateKey,
      verifierPublicKey: verifier.publicKey,
    });
    await expect(first.handle(request(first.address, built, approval))).rejects.toThrow(/before the signer state start/i);
  });

  it('M10 rejects extra keys and canonicalizes NFC strings', () => {
    const tx = txFields();
    const built = intent(getAddress(new Wallet(KEY).address), tx);
    expect(() => computeIntentHash({ ...built, version: '2' })).toThrow(/version/);
    expect(() => computeIntentHash({ ...built, surprise: true } as SigningIntent)).toThrow(/unknown field|forbidden/i);
    expect(canonicalJson('é')).toBe(canonicalJson('e\u0301'));
  });

  it('simulates with from set to the signer and records spend against hourly and daily budgets', async () => {
    let seen: PendingTransaction | undefined;
    const h = await boot({
      simulate: async (tx: PendingTransaction) => {
        seen = tx;
        return { success: true };
      },
      policy: { maxPerHour: '100', maxPerDay: '100' },
    });
    const firstTx = txFields({ value: '60' });
    const first = intent(h.wallet.address, firstTx, { amountIn: '60' });
    const signed = await h.server.handle(request(h.wallet.address, first, approvalFor(h, first)));
    expect(seen?.from).toBe(h.wallet.address);
    const audit = await readFile(h.p.audit, 'utf8');
    const allowLine = audit.trim().split('\n').at(-1)!;
    const allow = JSON.parse(allowLine) as { txHash?: string; decision: string };
    expect(allow.decision).toBe('allow');
    expect(allow.txHash).toBe(signed.signedTransaction && (await import('ethers')).keccak256(signed.signedTransaction));

    const secondTx = txFields({ value: '60', nonce: '1' });
    const second = intent(h.wallet.address, secondTx, { amountIn: '60', nonce: '2' });
    await expect(h.server.handle(request(h.wallet.address, second, approvalFor(h, second)))).rejects.toThrow(/hourly/i);
  });

  it('refuses a spending policy that is itself in dry-run', async () => {
    const p = await paths();
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: generateEd25519KeyPair().publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      port: 0,
      allow: ALLOW,
      initNonces: true,
      policy: { dryRun: true },
    })).rejects.toThrow(/dryRun/i);
  });

  it('prices by address only, requires https, fails closed, and counts native value', async () => {
    const p = await paths();
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: generateEd25519KeyPair().publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      port: 0,
      allow: ALLOW,
      initNonces: true,
      priceSourceUrl: 'http://prices.example/feed',
    })).rejects.toThrow(/https/i);

    const symbolOnly = await boot({ maxPerTxUsd: 1, prices: { USDC: 1 } });
    const transfer = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [ATTACKER, 1_000_000n]);
    const tx = txFields({ to: getAddress(USDC), data: transfer, value: '0' });
    const built = intent(symbolOnly.wallet.address, tx, {
      action: 'transfer',
      amountIn: '1000000',
      tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    });
    await expect(symbolOnly.server.handle(request(symbolOnly.wallet.address, built, approvalFor(symbolOnly, built)))).rejects.toThrow(/No price/i);

    const native = await boot({
      maxPerTxUsd: 1,
      prices: { [NATIVE_ADDRESS]: 100 },
    });
    const send = txFields({ value: '1000000000000000000' });
    const sendIntent = intent(native.wallet.address, send, { amountIn: '1000000000000000000' });
    await expect(native.server.handle(request(native.wallet.address, sendIntent, approvalFor(native, sendIntent)))).rejects.toThrow(/oversize/i);

    let fetches = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      if (fetches > 1) return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ [getAddress(USDC)]: 1 }));
    }) as typeof fetch;
    try {
      const priced = await boot({ maxPerTxUsd: 10, priceSourceUrl: 'https://prices.example/feed', priceTtlMs: 60_000 });
      const okTx = txFields({ to: getAddress(USDC), data: transfer, value: '0' });
      const ok = intent(priced.wallet.address, okTx, {
        action: 'transfer',
        amountIn: '1000000',
        tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
      });
      expect((await priced.server.handle(request(priced.wallet.address, ok, approvalFor(priced, ok)))).signedTransaction).toMatch(/^0x/);
      const again = intent(priced.wallet.address, { ...okTx, nonce: '1' }, {
        nonce: '2',
        action: 'transfer',
        amountIn: '1000000',
        tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
      });
      expect((await priced.server.handle(request(priced.wallet.address, again, approvalFor(priced, again)))).signedTransaction).toMatch(/^0x/);
      expect(fetches).toBe(1);

      const stale = await boot({ maxPerTxUsd: 10, priceSourceUrl: 'https://prices.example/feed', priceTtlMs: 0 });
      const third = intent(stale.wallet.address, okTx, {
        action: 'transfer',
        amountIn: '1000000',
        tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
      });
      await expect(stale.server.handle(request(stale.wallet.address, third, approvalFor(stale, third)))).rejects.toThrow(/Price source/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('signs message bytes as UTF-8 so 0x78 is not the byte x', async () => {
    const h = await boot({ messageAllowlist: ['x', '0x78'] });
    async function sign(message: string, nonce: string) {
      const built = intent(h.wallet.address, txFields(), {
        nonce,
        action: 'sign-message',
        amountIn: undefined,
        routeHash: computeMessageRouteHash(message),
        tx: undefined,
      });
      delete built.tx;
      const result = await h.server.handle({
        requestId: nonce,
        kind: 'message',
        chainId: CHAIN,
        from: h.wallet.address,
        intent: 'sign',
        message,
        structuredIntent: built,
        approval: approvalFor(h, built),
      });
      return result.signature!;
    }
    const asText = await sign('x', '1');
    const asHexLooking = await sign('0x78', '2');
    expect(asText).not.toBe(asHexLooking);
    expect(verifyMessage('x', asText)).toBe(h.wallet.address);
    expect(verifyMessage('0x78', asHexLooking)).toBe(h.wallet.address);
    expect(verifyMessage(getBytes('0x78'), asHexLooking)).not.toBe(h.wallet.address);
  });

  it('chains the audit log from the documented root and strips RPC URLs', async () => {
    const h = await boot({
      simulate: async () => ({ success: false, revertReason: 'rpc https://rpc.example/secret?token=1 failed' }),
    });
    const built = intent(h.wallet.address, txFields());
    await expect(h.server.handle(request(h.wallet.address, built, approvalFor(h, built)))).rejects.toThrow(/redacted-url/);
    const raw = await readFile(h.p.audit, 'utf8');
    expect(raw).not.toContain('rpc.example');
    expect(raw).toContain('[redacted-url]');
    const line = raw.trim().split('\n')[0];
    const parsed = JSON.parse(line) as { prevHash: string; to: string; value: string; routeHash: string; keyId: string; approvalSignature: string };
    expect(parsed.prevHash).toBe(AUDIT_ROOT);
    expect(parsed.to).toBe(getAddress(ROUTER));
    expect(parsed.value).toBe('0');
    expect(parsed.routeHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(parsed.keyId).toBe(h.wallet.address);
    expect(parsed.approvalSignature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('refuses a group-writable config unless the test override is set', async () => {
    const p = await paths();
    const configPath = join(p.root, 'signer.json');
    await writeFile(configPath, '{}', { mode: 0o644 });
    const verifier = generateEd25519KeyPair();
    const common = {
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      port: 0,
      allow: ALLOW,
      initNonces: true,
      configPath,
    };
    await expect(startSignerServer(common)).rejects.toThrow(/root/i);
    const allowed = await startSignerServer({ ...common, allowInsecureFilePermissions: true, port: 0 });
    servers.push(allowed);
    expect(allowed.address).toBe(getAddress(new Wallet(KEY).address));
  });

  it('serves a bare health check and leaves the unix socket mode 0660', async () => {
    const h = await boot();
    const health = await fetch(`http://127.0.0.1:${h.server.port}/health`);
    expect(await health.json()).toEqual({ ok: true });

    const p = await paths();
    await chmod(p.root, 0o750);
    const socketPath = join(p.root, 'signer.sock');
    const verifier = generateEd25519KeyPair();
    const server: EvalancheSignerServer & { endpoint: string } = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: p.audit,
      nonceStorePath: p.nonce,
      chainId: CHAIN,
      allow: ALLOW,
      initNonces: true,
      socketPath,
      simulate: async () => ({ success: true }),
    });
    servers.push(server);
    const info = await stat(socketPath);
    expect(info.mode & 0o777).toBe(0o660);
    const loose = await paths();
    await chmod(loose.root, 0o755);
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: loose.audit,
      nonceStorePath: loose.nonce,
      chainId: CHAIN,
      allow: ALLOW,
      initNonces: true,
      socketPath: join(loose.root, 'nope.sock'),
    })).rejects.toThrow(/0750/);
  });

  it('exports the approval error code used by a rejected signature', () => {
    expect(EvalancheErrorCode.APPROVAL_INVALID).toBe('APPROVAL_INVALID');
  });
});
