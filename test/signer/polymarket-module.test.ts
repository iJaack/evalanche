/**
 * Polymarket module. Orders are a dedicated kind. The module is off until
 * chains[137].polymarket.enabled is set. Generic typed data still cannot
 * sign these domains.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, id } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { NonceStore } from '../../src/signer/nonce-store';
import { computeApprovedTxHash, computeTypedDataRouteHash, signVerifierApproval, type SigningIntent, type TypedDataPayload } from '../../src/signer/intent';
import { assertClobAuth, assertPolymarketOrder, decodePolymarketTransaction, polymarketOrderTypehash } from '../../src/signer/polymarket-module';
import {
  PM_CHAIN_ID,
  PM_CLOB_AUTH_DOMAIN,
  PM_CLOB_AUTH_FIELDS,
  PM_CLOB_AUTH_MESSAGE,
  PM_CLOB_AUTH_VERSION,
  PM_CTF,
  PM_CTF_EXCHANGE_V1,
  PM_CTF_EXCHANGE_V2,
  PM_DOMAIN_NAME,
  PM_DOMAIN_VERSION_V2,
  PM_DOMAIN_VERSION_V3,
  PM_EXCHANGE_V3,
  PM_NEG_RISK_ADAPTER,
  PM_NEG_RISK_EXCHANGE_V1,
  PM_NEG_RISK_EXCHANGE_V2,
  PM_ORDER_FIELDS,
  PM_ORDER_TYPE,
  PM_ORDER_TYPEHASH,
  PM_PUSD,
  PM_USDC_E,
  PM_ZERO_BYTES32,
  POLYMARKET_DENY_CONTRACTS,
} from '../../src/signer/polymarket-addresses';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const TOKEN = '12345';
const CONDITION = `0x${'ab'.repeat(32)}`;
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function config(extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    perOrderPctNav: 5,
    perMarketPctNav: 10,
    totalOpenPctNav: 20,
    maxOrdersPerDay: 4,
    markets: [{ tokenId: TOKEN, conditionId: CONDITION, negRisk: false }],
    ...extra,
  };
}

function typedFor(now = Date.now(), patch: Record<string, unknown> = {}): TypedDataPayload {
  return {
    domain: {
      name: PM_DOMAIN_NAME,
      version: PM_DOMAIN_VERSION_V2,
      chainId: PM_CHAIN_ID,
      verifyingContract: PM_CTF_EXCHANGE_V2,
    },
    types: { Order: [...PM_ORDER_FIELDS] },
    value: {
      salt: '7',
      maker: WALLET,
      signer: WALLET,
      tokenId: TOKEN,
      makerAmount: '1000000',
      takerAmount: '2000000',
      side: 0,
      signatureType: 0,
      timestamp: String(now),
      metadata: PM_ZERO_BYTES32,
      builder: PM_ZERO_BYTES32,
      ...patch,
    },
  };
}

function orderIntent(patch: Record<string, unknown> = {}): NonNullable<SigningIntent['polymarket']> {
  return {
    conditionId: CONDITION,
    tokenId: TOKEN,
    outcome: 'yes',
    side: 'BUY',
    limitPrice: '0.5',
    size: '2000000',
    notionalUsd: '1',
    orderType: 'FOK',
    negRisk: false,
    verifyingContract: PM_CTF_EXCHANGE_V2,
    mid: '0.5',
    navUsd: '100',
    marketOpenUsd: '0',
    totalOpenUsd: '0',
    ...patch,
  };
}

function state(spent = 0n) {
  const hashes = new Set<string>();
  const salts = new Set<string>();
  const times: number[] = [];
  return {
    hasHash: (hash: string) => hashes.has(hash),
    hasSalt: (salt: string) => salts.has(salt),
    countSince: (at: number) => times.filter((time) => time >= at).length,
    spentSince: () => spent,
    note(hash: string, salt: string, at: number) {
      hashes.add(hash);
      salts.add(salt);
      times.push(at);
    },
  };
}

function check(typed: TypedDataPayload, order: NonNullable<SigningIntent['polymarket']>, cfg = config(), replay = state(), now = Date.now()) {
  assertPolymarketOrder({
    config: cfg,
    typed,
    intent: { polymarket: order } as SigningIntent,
    wallet: WALLET,
    now,
    orderHash: computeTypedDataRouteHash(typed),
    state: replay,
  });
}

describe('polymarket order checks', () => {
  it('pins the published V2 order typehash', () => {
    expect(id(PM_ORDER_TYPE)).toBe(PM_ORDER_TYPEHASH);
    expect(polymarketOrderTypehash()).toBe(PM_ORDER_TYPEHASH);
  });

  it('accepts a FOK buy at the mid', () => {
    const now = Date.now();
    expect(() => check(typedFor(now), orderIntent(now), config(), state(), now)).not.toThrow();
  });

  it('rejects each mismatched order field, domain, and cap', () => {
    const now = Date.now();
    const cases: Array<[string, () => void]> = [
      ['maker', () => check(typedFor(now, { maker: '0x000000000000000000000000000000000000bEEF' }), orderIntent())],
      ['signer', () => check(typedFor(now, { signer: '0x000000000000000000000000000000000000bEEF' }), orderIntent())],
      ['signatureType', () => check(typedFor(now, { signatureType: 1 }), orderIntent())],
      ['side', () => check(typedFor(now, { side: 1, makerAmount: '2000000', takerAmount: '1000000' }), orderIntent())],
      ['tokenId', () => check(typedFor(now, { tokenId: '99' }), orderIntent())],
      ['salt', () => {
        const replay = state();
        const typed = typedFor(now);
        check(typed, orderIntent(), config(), replay, now);
        replay.note(computeTypedDataRouteHash(typed), '7', now);
        check(typedFor(now, { salt: '7', timestamp: String(now + 1) }), orderIntent(), config(), replay, now);
      }],
      ['metadata', () => check(typedFor(now, { metadata: `0x${'11'.repeat(32)}` }), orderIntent())],
      ['builder', () => check(typedFor(now, { builder: `0x${'22'.repeat(32)}` }), orderIntent())],
      ['domain name', () => check({ ...typedFor(now), domain: { ...typedFor(now).domain, name: 'Other' } }, orderIntent())],
      ['domain version', () => check({ ...typedFor(now), domain: { ...typedFor(now).domain, version: '1' } }, orderIntent())],
      ['domain chain', () => check({ ...typedFor(now), domain: { ...typedFor(now).domain, chainId: 1 } }, orderIntent())],
      ['verifying contract', () => check({ ...typedFor(now), domain: { ...typedFor(now).domain, verifyingContract: PM_NEG_RISK_EXCHANGE_V2 } }, orderIntent({ verifyingContract: PM_NEG_RISK_EXCHANGE_V2 }))],
      ['negRisk', () => check(typedFor(now), orderIntent({ negRisk: true }))],
      ['FOK', () => check(typedFor(now), orderIntent({ orderType: 'GTC' }))],
      ['price band', () => check(typedFor(now), orderIntent({ mid: '0.1' }))],
      ['per-order cap', () => check(typedFor(now), orderIntent({ navUsd: '1' }))],
      ['proposer loosening', () => check(typedFor(now), orderIntent({ perOrderPctNav: 6 }))],
      ['timestamp', () => check(typedFor(now - 200_000), orderIntent(), config(), state(), now)],
      ['v3', () => check({
        ...typedFor(now),
        domain: { ...typedFor(now).domain, version: PM_DOMAIN_VERSION_V3, verifyingContract: PM_EXCHANGE_V3 },
      }, orderIntent({ verifyingContract: PM_EXCHANGE_V3 }))],
    ];
    for (const [label, run] of cases) {
      expect(run, label).toThrow();
    }
  });

  it('rejects a sell above the verifier balance and accepts one inside it', () => {
    const now = Date.now();
    const typed = typedFor(now, { side: 1, makerAmount: '2000000', takerAmount: '1000000' });
    expect(() => check(typed, orderIntent({ side: 'SELL' }), config(), state(), now)).toThrow(/balance/);
    expect(() => check(typed, orderIntent({ side: 'SELL', balance: '1000' }), config(), state(), now)).toThrow(/balance/);
    expect(() => check(typed, orderIntent({ side: 'SELL', balance: '2000000' }), config(), state(), now)).not.toThrow();
  });

  it('stops at the daily order count', () => {
    const now = Date.now();
    const replay = state();
    replay.note('a', '1', now);
    replay.note('b', '2', now);
    replay.note('c', '3', now);
    replay.note('d', '4', now);
    expect(() => check(typedFor(now, { salt: '8' }), orderIntent(), config(), replay, now)).toThrow(/per-day/);
  });

  it('buyOnly denies SELL and still allows a buy', () => {
    const now = Date.now();
    const sellTyped = typedFor(now, { side: 1, makerAmount: '2000000', takerAmount: '1000000' });
    const sell = orderIntent({ side: 'SELL', balance: '2000000' });
    expect(() => check(sellTyped, sell, config({ buyOnly: true }), state(), now)).toThrow(/buyOnly denies SELL/);
    expect(() => check(sellTyped, sell, config(), state(), now)).not.toThrow();
    expect(() => check(typedFor(now), orderIntent(), config({ buyOnly: true }), state(), now)).not.toThrow();
  });

  it('applies the USD ceilings on top of the NAV caps, and the stricter one wins', () => {
    const now = Date.now();
    expect(() => check(typedFor(now), orderIntent(), config({ maxOrderUsd: '0.5' }), state(), now)).toThrow(/maxOrderUsd/);
    expect(() => check(typedFor(now), orderIntent(), config({ maxOrderUsd: '10', perOrderPctNav: 0.5 }), state(), now)).toThrow(/per-order NAV cap/);
    expect(() => check(typedFor(now), orderIntent(), config({ maxOrderUsd: '1', maxDailyUsd: '1' }), state(1_000_000n), now)).toThrow(/daily USD ceiling/);
    expect(() => check(typedFor(now), orderIntent(), config({ maxDailyUsd: '1' }), state(0n), now)).not.toThrow();
    expect(() => check(typedFor(now), orderIntent(), config({ maxOrderUsd: '0', maxDailyUsd: '10' }), state(), now)).toThrow(/maxOrderUsd/);
  });
});

describe('clob-auth and polygon gates', () => {
  const ctf = new Interface([
    'function setApprovalForAll(address operator, bool approved)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  ]);
  const adapter = new Interface(['function redeemPositions(bytes32 conditionId, uint256[] amounts)']);
  const erc20 = new Interface(['function approve(address spender, uint256 amount)']);

  it('gates clob-auth separately and accepts one use', () => {
    const now = Date.now();
    const typed: TypedDataPayload = {
      domain: { name: PM_CLOB_AUTH_DOMAIN, version: PM_CLOB_AUTH_VERSION, chainId: PM_CHAIN_ID },
      types: { ClobAuth: [...PM_CLOB_AUTH_FIELDS] },
      value: {
        address: WALLET,
        timestamp: String(Math.floor(now / 1000)),
        nonce: '0',
        message: PM_CLOB_AUTH_MESSAGE,
      },
    };
    const replay = state();
    expect(() => assertClobAuth({
      config: config(),
      typed,
      wallet: WALLET,
      now,
      orderHash: 'h',
      state: replay,
    })).toThrow(/clob-auth is denied/);
    expect(() => assertClobAuth({
      config: config({ clobAuth: true }),
      typed,
      wallet: WALLET,
      now,
      orderHash: 'h',
      state: replay,
    })).not.toThrow();
    replay.note('h', 'auth', now);
    expect(() => assertClobAuth({
      config: config({ clobAuth: true }),
      typed,
      wallet: WALLET,
      now,
      orderHash: 'h',
      state: replay,
    })).toThrow(/already used/);
    expect(() => assertClobAuth({
      config: config({ clobAuth: true }),
      typed: { ...typed, value: { ...typed.value, nonce: '1' } },
      wallet: WALLET,
      now,
      orderHash: 'h2',
      state: state(),
    })).toThrow(/nonce/);
  });

  it('allows the gated calls and denies the rest', () => {
    const cfg = config();
    const approval = ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V2, true]);
    expect(decodePolymarketTransaction(PM_CTF, approval, cfg).op).toBe('set-approval');
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V2, false]), cfg).op).toBe('revoke');
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_NEG_RISK_EXCHANGE_V2, false]), cfg).op).toBe('revoke');
    const exchange = new Interface(['function pauseUser()', 'function unpauseUser()', 'function pauseTrading()']);
    expect(decodePolymarketTransaction(PM_CTF_EXCHANGE_V2, exchange.encodeFunctionData('pauseUser', []), cfg).op).toBe('pause-user');
    expect(decodePolymarketTransaction(PM_NEG_RISK_EXCHANGE_V2, exchange.encodeFunctionData('pauseUser', []), cfg).op).toBe('pause-user');
    expect(() => decodePolymarketTransaction(PM_CTF_EXCHANGE_V2, exchange.encodeFunctionData('unpauseUser', []), cfg)).toThrow(/denial/);
    expect(() => decodePolymarketTransaction(PM_CTF_EXCHANGE_V2, exchange.encodeFunctionData('pauseTrading', []), cfg)).toThrow(/denial/);
    expect(() => decodePolymarketTransaction(PM_EXCHANGE_V3, exchange.encodeFunctionData('pauseUser', []), cfg)).toThrow(/denial/);
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_EXCHANGE_V3, true]), cfg)).toThrow(/operator/);
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V1, false]), cfg)).toThrow(/not a current exchange/);
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V1, false]), config({ revokeV1Ctf: true })).op).toBe('revoke');
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_NEG_RISK_EXCHANGE_V1, false]), config({ revokeV1Ctf: true })).op).toBe('revoke');
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V1, true]), config({ revokeV1Ctf: true }))).toThrow(/operator, true/);
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V2, true]), config({ buyOnly: true }))).toThrow(/buyOnly denies setApprovalForAll/);
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V2, false]), config({ buyOnly: true })).op).toBe('revoke');
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V1, true]), config({ buyOnly: true, revokeV1Ctf: true }))).toThrow(/buyOnly/);
    const redeem = ctf.encodeFunctionData('redeemPositions', [PM_USDC_E, PM_ZERO_BYTES32, CONDITION, [1n]]);
    expect(decodePolymarketTransaction(PM_CTF, redeem, cfg).op).toBe('redeem');
    expect(decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('redeemPositions', [PM_PUSD, PM_ZERO_BYTES32, CONDITION, [1n]]), cfg).op).toBe('redeem');
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('redeemPositions', [PM_USDC_E, `0x${'11'.repeat(32)}`, CONDITION, [1n]]), cfg)).toThrow(/parentCollectionId/);
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('splitPosition', [PM_USDC_E, PM_ZERO_BYTES32, CONDITION, [1n], 1n]), cfg)).toThrow(/split and merge/);
    expect(() => decodePolymarketTransaction(PM_CTF, ctf.encodeFunctionData('mergePositions', [PM_USDC_E, PM_ZERO_BYTES32, CONDITION, [1n], 1n]), cfg)).toThrow(/split and merge/);
    expect(decodePolymarketTransaction(PM_NEG_RISK_ADAPTER, adapter.encodeFunctionData('redeemPositions', [CONDITION, [1n]]), cfg).op).toBe('redeem');
    expect(decodePolymarketTransaction(PM_USDC_E, erc20.encodeFunctionData('approve', [PM_CTF_EXCHANGE_V2, 0n]), cfg).op).toBe('revoke');
    expect(() => decodePolymarketTransaction(PM_USDC_E, erc20.encodeFunctionData('approve', [PM_CTF_EXCHANGE_V2, 1n]), cfg)).toThrow(/approvals to Polymarket are denied/);
    expect(() => decodePolymarketTransaction(PM_EXCHANGE_V3, approval, cfg)).toThrow(/denial/);
    expect(() => decodePolymarketTransaction(PM_CTF, approval, { enabled: false })).toThrow(/cannot be enabled/);
    expect(POLYMARKET_DENY_CONTRACTS[0]).toBe('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E');
  });
});

describe('polymarket signer path', () => {
  async function boot(
    polymarket: Record<string, unknown> | undefined,
    audit: string,
    extraChains: Record<string, unknown> = {},
  ) {
    const verifier = generateEd25519KeyPair();
    const server = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: audit,
      nonceStorePath: audit.replace(/a\.jsonl$/, 'n.json'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { 137: [{ address: '0x000000000000000000000000000000000000bEEF', selectors: ['0x'], roles: ['recipient'] }] },
      chains: {
        137: {
          enabled: true,
          gas: { maxFeeUsd: 5 },
          tokenCaps: { native: '1000000000000000000' },
          price: { prices: { native: 0.5 } },
          ...(polymarket ? { polymarket } : {}),
        },
        43114: { enabled: false },
        ...extraChains,
      },
    });
    servers.push(server);
    return { server, verifier };
  }

  function intent(order: NonNullable<SigningIntent['polymarket']>, typed: TypedDataPayload, nonce: string): SigningIntent {
    const now = Date.now();
    return {
      version: '1',
      intentId: `pm-${nonce}`,
      nonce,
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: WALLET,
      chainId: 137,
      venue: 'polymarket',
      action: 'polymarket-order',
      routeHash: computeTypedDataRouteHash(typed),
      polymarket: order,
    };
  }

  it('is disabled by default and signs one valid order when enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-'));
    const off = await boot(undefined, join(root, 'off-a.jsonl'));
    const deniedNow = Date.now();
    const deniedTyped = typedFor(deniedNow);
    const deniedIntent = intent(orderIntent(), deniedTyped, '1');
    const denied = signVerifierApproval({
      intent: deniedIntent,
      verifierPrivateKey: off.verifier.privateKey,
      verifierPublicKey: off.verifier.publicKey,
    });
    await expect(off.server.handle({
      requestId: 'off',
      kind: 'polymarket-order',
      chainId: 137,
      from: WALLET,
      intent: 'order',
      typedData: deniedTyped,
      structuredIntent: deniedIntent,
      approval: denied,
    })).rejects.toThrow(/Polymarket is denied/);

    const audit = join(root, 'on-a.jsonl');
    const on = await boot(config(), audit);
    const now = Date.now();
    const typed = typedFor(now);
    const built = intent(orderIntent(), typed, '1');
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: on.verifier.privateKey,
      verifierPublicKey: on.verifier.publicKey,
    });
    const signed = await on.server.handle({
      requestId: 'on',
      kind: 'polymarket-order',
      chainId: 137,
      from: WALLET,
      intent: 'order',
      typedData: typed,
      structuredIntent: built,
      approval,
    });
    expect(signed.signature).toMatch(/^0x/);
    const lines = (await readFile(audit, 'utf8')).trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]) as { reason?: string };
    expect(last.reason).toMatch(/expiration, nonce, feeRateBps, and taker are not signed/);

    const again = intent(orderIntent(), typed, '2');
    const replay = signVerifierApproval({
      intent: again,
      verifierPrivateKey: on.verifier.privateKey,
      verifierPublicKey: on.verifier.publicKey,
    });
    await expect(on.server.handle({
      requestId: 'replay',
      kind: 'polymarket-order',
      chainId: 137,
      from: WALLET,
      intent: 'order',
      typedData: typed,
      structuredIntent: again,
      approval: replay,
    })).rejects.toThrow(/salt|hash/);

    await expect(on.server.handle({
      requestId: 'generic',
      kind: 'typed-data',
      chainId: 137,
      from: WALLET,
      intent: 'generic',
      typedData: typed,
      structuredIntent: {
        ...built,
        nonce: '3',
        action: 'sign',
        venue: 'eip712',
        polymarket: undefined,
      },
      approval: signVerifierApproval({
        intent: { ...built, nonce: '3', action: 'sign', venue: 'eip712', polymarket: undefined },
        verifierPrivateKey: on.verifier.privateKey,
        verifierPublicKey: on.verifier.publicKey,
      }),
    })).rejects.toThrow(/Polymarket typed data is denied/);
  });

  it('persists the daily USD ceiling across a restart and ignores a record with no amount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-usd-'));
    const audit = join(root, 'a.jsonl');
    const noncePath = join(root, 'n.json');
    const first = await boot(config({ maxDailyUsd: '1', maxOrderUsd: '1' }), audit);
    const signOrder = async (h: Awaited<ReturnType<typeof boot>>, salt: string, nonce: string) => {
      const now = Date.now();
      const typed = typedFor(now, { salt });
      const built = intent(orderIntent(), typed, nonce);
      return h.server.handle({
        requestId: `usd-${nonce}`,
        kind: 'polymarket-order',
        chainId: 137,
        from: WALLET,
        intent: 'order',
        typedData: typed,
        structuredIntent: built,
        approval: signVerifierApproval({
          intent: built,
          verifierPrivateKey: h.verifier.privateKey,
          verifierPublicKey: h.verifier.publicKey,
        }),
      });
    };
    expect((await signOrder(first, '71', '1')).signature).toMatch(/^0x/);
    await first.server.close();
    servers.pop();
    const stored = JSON.parse(await readFile(noncePath, 'utf8')) as { polymarketOrders: Array<{ usdMicros?: string }> };
    expect(stored.polymarketOrders[0]?.usdMicros).toBe('1000000');
    delete stored.polymarketOrders[0].usdMicros;
    await writeFile(noncePath, `${JSON.stringify(stored)}\n`);
    const second = await boot(config({ maxDailyUsd: '1', maxOrderUsd: '1' }), audit);
    expect((await signOrder(second, '72', '2')).signature).toMatch(/^0x/);
    await expect(signOrder(second, '73', '3')).rejects.toThrow(/daily USD ceiling/);
  });

  it('counts the daily USD total from UTC midnight and skips clob-auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-utc-'));
    const store = await NonceStore.open(join(root, 'n.json'), true, { allowInsecureFilePermissions: true });
    try {
      const now = Date.now();
      const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
      store.noteOrder('yesterday', '1', dayStart - 1, 'order', '5000000');
      store.noteOrder('today', '2', dayStart, 'order', '1000000');
      store.noteOrder('auth', '3', dayStart + 1, 'auth', '9000000');
      expect(store.spentSince(dayStart)).toBe(1_000_000n);
      expect(store.ordersSince(dayStart)).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('fails startup when a Polymarket ceiling flag is the wrong shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-bad-'));
    await expect(boot(config({ buyOnly: 'yes' }), join(root, 'buy-a.jsonl'))).rejects.toThrow(/buyOnly must be a boolean/);
    await expect(boot(config({ revokeV1Ctf: 1 }), join(root, 'v1-a.jsonl'))).rejects.toThrow(/revokeV1Ctf must be a boolean/);
    await expect(boot(config({ maxOrderUsd: '-1' }), join(root, 'order-a.jsonl'))).rejects.toThrow(/maxOrderUsd/);
    await expect(boot(config({ maxDailyUsd: '1.1234567' }), join(root, 'daily-a.jsonl'))).rejects.toThrow(/maxDailyUsd/);
  });

  it('signs a gated redeem and denies a CTF call while the module is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-tx-'));
    const ctf = new Interface([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ]);
    const data = ctf.encodeFunctionData('redeemPositions', [PM_USDC_E, PM_ZERO_BYTES32, CONDITION, [1n]]);
    const on = await boot(config(), join(root, 'a.jsonl'));
    const now = Date.now();
    const tx = {
      to: PM_CTF,
      value: '0',
      data,
      chainId: 137,
      nonce: '0',
      gasLimit: '200000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type: 0,
    };
    const built: SigningIntent = {
      version: '1',
      intentId: 'redeem',
      nonce: '1',
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: WALLET,
      chainId: 137,
      venue: 'polymarket',
      action: 'polymarket-redeem',
      routeHash: computeApprovedTxHash(tx),
      tx,
    };
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: on.verifier.privateKey,
      verifierPublicKey: on.verifier.publicKey,
    });
    const signed = await on.server.handle({
      requestId: 'redeem',
      kind: 'transaction',
      chainId: 137,
      from: WALLET,
      to: PM_CTF,
      value: '0',
      data,
      gasLimit: '200000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'redeem',
      structuredIntent: built,
      approval,
    });
    expect(signed.signedTransaction).toMatch(/^0x/);

    const off = await boot(undefined, join(root, 'off-a.jsonl'));
    const offNow = Date.now();
    const offIntent: SigningIntent = { ...built, nonce: '1', intentId: 'off', createdAt: offNow, expiresAt: offNow + 60_000 };
    const offApproval = signVerifierApproval({
      intent: offIntent,
      verifierPrivateKey: off.verifier.privateKey,
      verifierPublicKey: off.verifier.publicKey,
    });
    await expect(off.server.handle({
      requestId: 'off-tx',
      kind: 'transaction',
      chainId: 137,
      from: WALLET,
      to: PM_CTF,
      value: '0',
      data,
      gasLimit: '200000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'redeem',
      structuredIntent: offIntent,
      approval: offApproval,
    })).rejects.toThrow(/built-in Polymarket denial/);
  });

  it('signs clob-auth once on the server path and refuses it when the flag is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-auth-'));
    const on = await boot(config({ clobAuth: true }), join(root, 'on-a.jsonl'));
    const now = Date.now();
    const typed: TypedDataPayload = {
      domain: { name: PM_CLOB_AUTH_DOMAIN, version: PM_CLOB_AUTH_VERSION, chainId: PM_CHAIN_ID },
      types: { ClobAuth: [...PM_CLOB_AUTH_FIELDS] },
      value: {
        address: WALLET,
        timestamp: String(Math.floor(now / 1000)),
        nonce: '0',
        message: PM_CLOB_AUTH_MESSAGE,
      },
    };
    function authIntent(nonce: string, at = Date.now()): SigningIntent {
      return {
        version: '1',
        intentId: `auth-${nonce}`,
        nonce,
        createdAt: at,
        expiresAt: at + 60_000,
        wallet: WALLET,
        chainId: 137,
        venue: 'polymarket',
        action: 'clob-auth',
        routeHash: computeTypedDataRouteHash(typed),
      };
    }
    const built = authIntent('1', now);
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: on.verifier.privateKey,
      verifierPublicKey: on.verifier.publicKey,
    });
    const signed = await on.server.handle({
      requestId: 'auth',
      kind: 'clob-auth',
      chainId: 137,
      from: WALLET,
      intent: 'clob-auth',
      typedData: typed,
      structuredIntent: built,
      approval,
    });
    expect(signed.signature).toMatch(/^0x/);
    const again = authIntent('2');
    await expect(on.server.handle({
      requestId: 'auth-2',
      kind: 'clob-auth',
      chainId: 137,
      from: WALLET,
      intent: 'clob-auth',
      typedData: typed,
      structuredIntent: again,
      approval: signVerifierApproval({
        intent: again,
        verifierPrivateKey: on.verifier.privateKey,
        verifierPublicKey: on.verifier.publicKey,
      }),
    })).rejects.toThrow(/already used/);

    const off = await boot(undefined, join(root, 'off-a.jsonl'));
    const offIntent = authIntent('1');
    await expect(off.server.handle({
      requestId: 'auth-off',
      kind: 'clob-auth',
      chainId: 137,
      from: WALLET,
      intent: 'clob-auth',
      typedData: typed,
      structuredIntent: offIntent,
      approval: signVerifierApproval({
        intent: offIntent,
        verifierPrivateKey: off.verifier.privateKey,
        verifierPublicKey: off.verifier.publicKey,
      }),
    })).rejects.toThrow(/clob-auth is denied/);
  });

  it('refuses an order payload sent as clob-auth or typed-data, and a polymarket-order off chain 137', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-kind-'));
    const typed = typedFor(Date.now());
    const chainOne = {
      1: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 3000 } },
      },
    };
    const on = await boot(config({ clobAuth: true }), join(root, 'a.jsonl'), chainOne);
    const now = Date.now();
    const asAuth: SigningIntent = {
      version: '1',
      intentId: 'kind-auth',
      nonce: '1',
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: WALLET,
      chainId: 137,
      venue: 'polymarket',
      action: 'clob-auth',
      routeHash: computeTypedDataRouteHash(typed),
    };
    await expect(on.server.handle({
      requestId: 'kind-auth',
      kind: 'clob-auth',
      chainId: 137,
      from: WALLET,
      intent: 'kind',
      typedData: typed,
      structuredIntent: asAuth,
      approval: signVerifierApproval({
        intent: asAuth,
        verifierPrivateKey: on.verifier.privateKey,
        verifierPublicKey: on.verifier.publicKey,
      }),
    })).rejects.toThrow(/ClobAuth/);

    const asTyped: SigningIntent = {
      ...asAuth,
      nonce: '2',
      intentId: 'kind-typed',
      chainId: 1,
      venue: 'eip712',
      action: 'sign',
      polymarket: undefined,
    };
    await expect(on.server.handle({
      requestId: 'kind-typed',
      kind: 'typed-data',
      chainId: 1,
      from: WALLET,
      intent: 'kind',
      typedData: typed,
      structuredIntent: asTyped,
      approval: signVerifierApproval({
        intent: asTyped,
        verifierPrivateKey: on.verifier.privateKey,
        verifierPublicKey: on.verifier.publicKey,
      }),
    })).rejects.toThrow(/Polymarket typed data is denied/);

    const asOrder: SigningIntent = {
      ...asAuth,
      nonce: '3',
      intentId: 'kind-order',
      chainId: 1,
      action: 'polymarket-order',
      polymarket: orderIntent(),
    };
    await expect(on.server.handle({
      requestId: 'kind-order',
      kind: 'polymarket-order',
      chainId: 1,
      from: WALLET,
      intent: 'kind',
      typedData: typed,
      structuredIntent: asOrder,
      approval: signVerifierApproval({
        intent: asOrder,
        verifierPrivateKey: on.verifier.privateKey,
        verifierPublicKey: on.verifier.publicKey,
      }),
    })).rejects.toThrow(/Polymarket is denied|not 137|chain/);
  });

  it('signs setApprovalForAll(false) and pauseUser as kill switches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-kill-'));
    const on = await boot(config(), join(root, 'a.jsonl'));
    const ctf = new Interface(['function setApprovalForAll(address operator, bool approved)']);
    const exchange = new Interface(['function pauseUser()']);
    const calls: Array<[string, string]> = [
      [PM_CTF, ctf.encodeFunctionData('setApprovalForAll', [PM_CTF_EXCHANGE_V2, false])],
      [PM_CTF_EXCHANGE_V2, exchange.encodeFunctionData('pauseUser', [])],
    ];
    for (const [index, [to, data]] of calls.entries()) {
      const nonce = String(index + 1);
      const now = Date.now();
      const tx = {
        to,
        value: '0',
        data,
        chainId: 137,
        nonce: '0',
        gasLimit: '200000',
        maxFeePerGas: '0',
        maxPriorityFeePerGas: '0',
        gasPrice: '1',
        type: 0,
      };
      const built: SigningIntent = {
        version: '1',
        intentId: `kill-${nonce}`,
        nonce,
        createdAt: now,
        expiresAt: now + 60_000,
        wallet: WALLET,
        chainId: 137,
        venue: 'polymarket',
        action: 'polymarket-kill',
        routeHash: computeApprovedTxHash(tx),
        tx,
      };
      const signed = await on.server.handle({
        requestId: `kill-${nonce}`,
        kind: 'transaction',
        chainId: 137,
        from: WALLET,
        to,
        value: '0',
        data,
        gasLimit: '200000',
        gasPrice: '1',
        maxFeePerGas: '0',
        maxPriorityFeePerGas: '0',
        nonce: 0,
        type: 0,
        intent: 'kill',
        structuredIntent: built,
        approval: signVerifierApproval({
          intent: built,
          verifierPrivateKey: on.verifier.privateKey,
          verifierPublicKey: on.verifier.publicKey,
        }),
      });
      expect(signed.signedTransaction).toMatch(/^0x/);
    }
  });
});
