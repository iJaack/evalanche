import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction, Wallet } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chainModule from '../../src/signer/chain-policy';
import * as intentModule from '../../src/signer/intent';
import * as serverModule from '../../src/signer/server';
import * as publicModule from '../../src/index';
import { clone, CLUSTERS, deriveKey, LABELS, makeEvmIntent, requireFn, sha256, USDC, WSOL, type RecordValue } from './solana-test-helpers';
import { GENESIS, key, poolFixture, PROGRAMS, PROVISIONAL_SOLANA_POLICY, SYSTEM, TOKEN, TOKEN_2022, USDT } from './solana-message-helpers';

const MAINNET = 'solana:mainnet';
const DEVNET = 'solana:devnet';
const MAINNET_MINTS = {
  [WSOL]: { symbol: 'wSOL', decimals: 9, tokenProgram: TOKEN },
  [USDC]: { symbol: 'USDC', decimals: 6, tokenProgram: TOKEN },
  [USDT]: { symbol: 'USDT', decimals: 6, tokenProgram: TOKEN },
};
/** Input is the solana object (as in resolveSolanaPolicy), not a {solana: ...} wrapper.
 * Price shape reuses ChainPriceConfig: asset -> {min:number,max:number}, optional
 * asset -> number references. Values below are synthetic test bounds, not policy defaults.
 * Programs need uniqueness and subset membership, not ordering (the doc specifies none).
 */
function template(maxFeeUsd: string = PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault, maxPerTxUsd = '100'): RecordValue {
  return { enabled: false, secretKeyPath: join(tmpdir(), 'evalanche-test-only-never-read', 'solana.key'), clusters: {
    [MAINNET]: {
      enabled: false, killSwitch: false,
      rpcUrls: ['https://rpc-a.example.org', 'https://rpc-b.example.org'], rpcQuorum: 2, rpcTimeoutMs: 8000,
      genesisHash: GENESIS[MAINNET], programs: [...PROGRAMS], innerPrograms: [], mints: clone(MAINNET_MINTS),
      delegates: [], nonceAccounts: [], alt: { enabled: false }, allowWsol: false,
      jupiter: { enabled: false, allowPoolTransfers: PROVISIONAL_SOLANA_POLICY.allowPoolTransfersDefault, pools: [], apiBaseUrl: 'https://api.jup.ag/swap/v1' },
      fees: { maxComputeUnitLimit: 400000, maxComputeUnitPriceMicroLamports: '2500000', maxPriorityFeeLamports: '1000000', maxFeeUsd },
      maxSlippageBps: 100, quoteMaxAgeMs: 30000, maxIntentTtlMs: 120000, maxPerTxUsd, maxRentLamports: '3000000',
      // Explicit fixture caps only; final tokenCaps remain pending Giacomo.
      tokenCaps: { native: '1000000000', [WSOL]: '1000000000', [USDC]: '100000000', [USDT]: '100000000' },
      price: { ids: { native: 'solana' }, priceFeed: { provider: 'coingecko', maxAgeMs: 600000 },
        bounds: { native: { min: 1, max: 1000 }, [WSOL]: { min: 1, max: 1000 }, [USDC]: { min: 0.5, max: 2 }, [USDT]: { min: 0.5, max: 2 } },
        prices: { native: 100, [WSOL]: 100, [USDC]: 1, [USDT]: 1 } },
    },
    [DEVNET]: { enabled: false },
  } };
}
function cluster(config: RecordValue): RecordValue { return config.clusters[MAINNET]; }
function at(root: RecordValue, path: string): RecordValue {
  return path ? path.split('/').reduce((value, part) => value[part], root) : root;
}
function set(config: RecordValue, path: string, value: unknown): void {
  const parts = path.split('/'); const last = parts.pop()!; at(config, parts.join('/'))[last] = value;
}
let offlineFetch: ReturnType<typeof vi.fn>;
const servers: Array<{ close(): Promise<void> }> = [];
const roots: string[] = [];
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 config test: fetch forbidden'); }); vi.stubGlobal('fetch', offlineFetch);
});
afterEach(async () => {
  try {
    while (servers.length) await servers.pop()!.close();
    expect(offlineFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  }
});
async function boot(solana: RecordValue) {
  const start = requireFn(serverModule, 'startSignerServer');
  const root = await mkdtemp(join(tmpdir(), 'solana-pr2-')); roots.push(root);
  const verifier = deriveKey(LABELS.verifier);
  const wallet = new Wallet('0x' + sha256('evalanche-test-only/pr2/evm-wallet').toString('hex'));
  const server = await start({ solana, privateKey: wallet.privateKey, verifierPublicKey: verifier.publicHex,
    token: 'offline-pr2', auditLogPath: join(root, 'audit.jsonl'), nonceStorePath: join(root, 'nonces.json'),
    initNonces: true, allowInsecureFilePermissions: true, chainId: 43114, port: 0,
    allow: { 43114: [{ address: makeEvmIntent().tx.to, selectors: ['0x'], roles: ['recipient'] }] },
    simulate: async () => ({ success: true }),
  });
  servers.push(server); return { server, wallet, verifier };
}
async function signEvm(h: Awaited<ReturnType<typeof boot>>) {
  const intent = makeEvmIntent(); intent.wallet = h.wallet.address; intent.createdAt = Date.now(); intent.expiresAt = intent.createdAt + 60000;
  const approval = requireFn(intentModule, 'signVerifierApproval')({ intent, verifierPrivateKey: h.verifier.seedHex, verifierPublicKey: h.verifier.publicHex });
  const result = await h.server.handle({ requestId: 'pr2-evm', kind: 'transaction', chainId: 43114, from: intent.wallet,
    intent: 'Offline EVM zero-value transfer', structuredIntent: intent, approval, ...intent.tx, nonce: Number(intent.tx.nonce) });
  const signed = Transaction.from(result.signedTransaction);
  expect(signed.from).toBe(h.wallet.address); expect(signed.to).toBe(intent.tx.to); expect(signed.chainId).toBe(43114n);
  expect(signed.value).toBe(0n); expect(signed.data).toBe('0x');
}

describe('PR2 full typed Solana config', () => {
  it.each(['0', '100', '1000.000000'])('preserves configured maxPerTxUsd verbatim: %s', (value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault, value); const result = resolve(config);
    expect(result.enabled).toBe(false);
    expect(result.clusters[MAINNET]).toMatchObject(cluster(config));
    expect(result.clusters[MAINNET].price.bounds[USDC]).toEqual({ min: 0.5, max: 2 });
    expect(result.clusters[MAINNET].price.bounds).not.toHaveProperty(USDC.toLowerCase());
    expect(result.clusters[MAINNET].fees.maxFeeUsd).toBe(PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault); expect(result.clusters[MAINNET].maxPerTxUsd).toBe(value);
  });
  it.each([undefined, { enabled: false, clusters: {} }, { clusters: { [MAINNET]: {} } }])('defaults flags with no other invented economics (except provisional maxFeeUsd): %j', (input) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const result = resolve(input);
    expect(result.enabled).toBe(false);
    for (const name of CLUSTERS) {
      const c = result.clusters[name];
      expect(c.enabled).toBe(false); expect(c.killSwitch).toBe(false); expect(c.alt.enabled).toBe(false); expect(c.allowWsol).toBe(false);
      expect(c.jupiter.enabled).toBe(false); expect(c.jupiter.allowPoolTransfers).toBe(PROVISIONAL_SOLANA_POLICY.allowPoolTransfersDefault);
      // Exclude maxFeeUsd explicitly: provisional default per Builder; no other economic defaults.
      expect(c.fees?.maxFeeUsd).toBe(PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault);
      for (const field of ['maxComputeUnitLimit', 'maxComputeUnitPriceMicroLamports', 'maxPriorityFeeLamports']) {
        expect(c.fees?.[field], `fees.${field}`).toBeUndefined();
      }
      for (const field of ['maxPerTxUsd', 'maxRentLamports', 'maxSlippageBps', 'quoteMaxAgeMs', 'maxIntentTtlMs', 'tokenCaps', 'price', 'rpcUrls', 'rpcQuorum', 'rpcTimeoutMs', 'genesisHash']) {
        expect(c[field], field).toBeUndefined();
      }
    }
  });
  it('defaults omitted maxFeeUsd in template fees to the provisional Builder cap', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); delete cluster(config).fees.maxFeeUsd;
    expect(resolve(config).clusters[MAINNET].fees.maxFeeUsd).toBe(PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault);
  });
  it.each(['2', '0.25'])('keeps explicit valid maxFeeUsd %s configurable', (fee) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig');
    expect(resolve(template(fee)).clusters[MAINNET].fees.maxFeeUsd).toBe(fee);
  });
  it('requires maxPerTxUsd on a template-shaped policy-bearing cluster without an implicit default', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); delete cluster(config).maxPerTxUsd;
    if (PROVISIONAL_SOLANA_POLICY.maxPerTxUsdRequired) expect(() => resolve(config)).toThrow();
    else expect(resolve(config).clusters[MAINNET].maxPerTxUsd).toBeUndefined();
  });
  it('defaults omitted allowPoolTransfers to the provisional false value', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); delete cluster(config).jupiter.allowPoolTransfers;
    expect(resolve(config).clusters[MAINNET].jupiter.allowPoolTransfers).toBe(PROVISIONAL_SOLANA_POLICY.allowPoolTransfersDefault);
  });
  it.each([PROVISIONAL_SOLANA_POLICY.allowPoolTransfersDefault, true])('preserves explicit allowPoolTransfers boolean %s', (value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).jupiter.allowPoolTransfers = value;
    expect(resolve(config).clusters[MAINNET].jupiter.allowPoolTransfers).toBe(value);
  });
  it('exports exact per-cluster genesis pins', () => { expect(chainModule).toHaveProperty('SOLANA_GENESIS_HASHES', GENESIS); });
  it('exports exactly the six phase-1 public program ids', () => {
    const values = (chainModule as RecordValue).SOLANA_PHASE1_PROGRAM_IDS;
    expect(values).toBeDefined(); expect(Array.isArray(values)).toBe(true); expect([...values].sort()).toEqual([...PROGRAMS].sort());
  });
  // API choice: mint registry mirrors the doc's mints record, including tokenProgram.
  it('exports exactly the three mainnet mint metadata entries', () => { expect(chainModule).toHaveProperty('SOLANA_PHASE1_MAINNET_MINTS', MAINNET_MINTS); });
  it.each(['resolveSolanaConfig', 'assertSolanaClusterReady'])('re-exports %s through signer and package index', (name) => {
    const fn = requireFn(chainModule, name); expect(requireFn(publicModule, name)).toBe(fn);
  });
  it.each(['SOLANA_GENESIS_HASHES', 'SOLANA_PHASE1_PROGRAM_IDS', 'SOLANA_PHASE1_MAINNET_MINTS'])('re-exports constant %s', (name) => {
    expect(chainModule).toHaveProperty(name); expect(publicModule).toHaveProperty(name, (chainModule as RecordValue)[name]);
  });
  it('accepts unordered unique program subsets', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).programs = [TOKEN, SYSTEM];
    expect(new Set(resolve(config).clusters[MAINNET].programs)).toEqual(new Set([TOKEN, SYSTEM]));
  });
  it('keeps devnet fixture mints, genesis and RPC settings separate from mainnet', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); const c = clone(cluster(config)); const mint = key('devnet-mint');
    c.genesisHash = GENESIS[DEVNET]; c.rpcUrls = ['https://dev-a.example.org', 'https://dev-b.example.org'];
    c.mints = { [mint]: { symbol: 'USDC', decimals: 6, tokenProgram: TOKEN } }; c.tokenCaps = { native: '0', [mint]: '100' };
    c.price = { ids: { native: 'solana' }, priceFeed: { provider: 'coingecko', maxAgeMs: 600000 }, bounds: { native: { min: 1, max: 1000 }, [mint]: { min: 0.5, max: 2 } } };
    config.clusters[DEVNET] = c; const result = resolve(config);
    expect(result.clusters[DEVNET]).toMatchObject(c); expect(result.clusters[MAINNET]).toMatchObject(cluster(config));
    expect(result.clusters[DEVNET].mints).not.toHaveProperty(USDC);
  });
  it.each([0, 255])('accepts mint decimals boundary %i', (decimals) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).mints[USDC].decimals = decimals;
    expect(resolve(config).clusters[MAINNET].mints[USDC].decimals).toBe(decimals);
  });
  it('accepts Token-2022 metadata without granting extension support', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).mints[USDC].tokenProgram = TOKEN_2022;
    expect(resolve(config).clusters[MAINNET].mints[USDC].tokenProgram).toBe(TOKEN_2022);
  });
  it('does not hardcode pending Ops proposals as upper bounds', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); const c = cluster(config);
    c.fees = { maxComputeUnitLimit: 400001, maxComputeUnitPriceMicroLamports: '2500001', maxPriorityFeeLamports: '1000001', maxFeeUsd: '2' }; c.maxRentLamports = '3000001';
    expect(resolve(config).clusters[MAINNET].fees).toEqual(c.fees);
  });
  it.each(['0', '0.50', '2', '2.000000'])('accepts canonical USD representation %s for both caps', (usd) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const result = resolve(template(usd, usd));
    expect(result.clusters[MAINNET].fees.maxFeeUsd).toBe(usd); expect(result.clusters[MAINNET].maxPerTxUsd).toBe(usd);
  });
});

const C = `clusters/${MAINNET}`;
const UNKNOWN_LEVELS = ['', 'clusters', C, `${C}/jupiter`, `${C}/fees`, `${C}/alt`, `${C}/price`, `${C}/price/priceFeed`, `${C}/price/bounds/native`, `${C}/mints/${USDC}`];
describe('PR2 dormant config remains strict', () => {
  it.each([null, true, [], 'disabled', 1])('rejects non-object config %j', (input) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); expect(() => resolve(input)).toThrow();
  });
  it.each(UNKNOWN_LEVELS)('rejects unknown key at %s', (path) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); at(config, path).unexpected = true;
    expect(() => resolve(config)).toThrow();
  });
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    it('rejects ' + name + ' at every config record and asset-map level', () => {
      const resolve = requireFn(chainModule, 'resolveSolanaConfig');
      for (const path of [...UNKNOWN_LEVELS, `${C}/mints`, `${C}/tokenCaps`, `${C}/price/ids`, `${C}/price/bounds`, `${C}/price/prices`]) {
        const config = template(); Object.defineProperty(at(config, path), name, { value: true, enumerable: true });
        expect(() => resolve(config), path).toThrow();
      }
    });
  }
  it.each(['enabled', `${C}/enabled`, `${C}/killSwitch`, `${C}/alt/enabled`, `${C}/allowWsol`, `${C}/jupiter/enabled`, `${C}/jupiter/allowPoolTransfers`])('requires a boolean at %s', (path) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig');
    for (const value of ['false', 0, null]) { const config = template(); set(config, path, value); expect(() => resolve(config)).toThrow(); }
  });
  it.each([
    ['one RPC', 'rpcUrls', ['https://rpc-a.example.org']], ['three RPCs', 'rpcUrls', ['https://a.example.org', 'https://b.example.org', 'https://c.example.org']],
    ['duplicate RPC', 'rpcUrls', ['https://a.example.org', 'https://a.example.org']], ['HTTP RPC', 'rpcUrls', ['http://a.example.org', 'https://b.example.org']],
    ['quorum 1 (local-validator exception has no production profile here)', 'rpcQuorum', 1],
    ['zero timeout', 'rpcTimeoutMs', 0], ['over timeout', 'rpcTimeoutMs', 8001],
    ['ALT enabled', 'alt/enabled', true], ['durable nonce account', 'nonceAccounts', [key('nonce')]],
    ['zero nonce account', 'nonceAccounts', [SYSTEM]], ['noncanonical inner program', 'innerPrograms', ['0OIl']],
    ['duplicate programs', 'programs', [TOKEN, TOKEN]], ['noncanonical program', 'programs', ['0OIl']], ['unreviewed program', 'programs', [key('unknown-program')]],
    ['HTTP Jupiter', 'jupiter/apiBaseUrl', 'http://api.jup.ag/swap/v1'], ['non-URL Jupiter', 'jupiter/apiBaseUrl', 'not-a-url'],
    ['zero CU limit', 'fees/maxComputeUnitLimit', 0], ['float CU limit', 'fees/maxComputeUnitLimit', 1.5], ['unsafe CU limit', 'fees/maxComputeUnitLimit', Number.MAX_SAFE_INTEGER + 1],
    ['negative price', 'fees/maxComputeUnitPriceMicroLamports', '-1'], ['numeric price', 'fees/maxComputeUnitPriceMicroLamports', 2500000], ['exponent price', 'fees/maxComputeUnitPriceMicroLamports', '1e3'],
    ['nondecimal priority cap', 'fees/maxPriorityFeeLamports', '1.5'], ['numeric priority cap', 'fees/maxPriorityFeeLamports', 1],
    ['nondecimal rent', 'maxRentLamports', '01'], ['numeric rent', 'maxRentLamports', 1],
    ['nondecimal token cap', `tokenCaps/${USDC}`, '1e3'], ['numeric token cap', `tokenCaps/${USDC}`, 1],
    ['unconfigured token cap', `tokenCaps/${key('unconfigured-mint')}`, '1'],
    ['invalid token program', `mints/${USDC}/tokenProgram`, SYSTEM], ['negative decimals', `mints/${USDC}/decimals`, -1], ['excess decimals', `mints/${USDC}/decimals`, 256], ['float decimals', `mints/${USDC}/decimals`, 6.5],
    ['noncanonical delegate', 'delegates', ['0OIl']], ['duplicate delegate', 'delegates', [key('delegate'), key('delegate')]], ['zero delegate', 'delegates', [SYSTEM]],
    ['excess intent TTL', 'maxIntentTtlMs', 120001], ['zero quote age', 'quoteMaxAgeMs', 0], ['excess slippage', 'maxSlippageBps', 10001],
    ['negative slippage', 'maxSlippageBps', -1], ['float slippage', 'maxSlippageBps', 0.5],
    ['wrong native price id', 'price/ids/native', 'ethereum'], ['unknown feed provider', 'price/priceFeed/provider', 'other'],
    ['zero feed age', 'price/priceFeed/maxAgeMs', 0], ['invalid price reference', 'price/prices/native', '100'],
    ['inverted bounds', 'price/bounds/native', { min: 2, max: 1 }], ['nonpositive bound', 'price/bounds/native', { min: 0, max: 1 }],
  ] as Array<[string, string, unknown]>)('rejects %s', (_name, path, value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); set(config, `${C}/${path}`, value);
    expect(() => resolve(config)).toThrow();
  });
  it.each(['0.5000001', '-1', '1e3', '01', ' 2'])('rejects malformed USD %j in both caps', (value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig');
    expect(() => resolve(template(value, '100'))).toThrow(); expect(() => resolve(template('2', value))).toThrow();
  });
  it.each(['', 'relative/key', 1, null])('rejects invalid secretKeyPath %j without reading it', (value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); config.secretKeyPath = value; expect(() => resolve(config)).toThrow();
  });
  it.each(CLUSTERS)('rejects swapped and arbitrary genesis on %s', (name) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig');
    for (const genesisHash of [GENESIS[name === MAINNET ? DEVNET : MAINNET], key('wrong-genesis')]) {
      const config = template(); config.clusters[name].genesisHash = genesisHash; expect(() => resolve(config)).toThrow();
    }
  });
  it.each([SYSTEM, key('unreviewed-mint')])('rejects zero/unreviewed mainnet mint %s', (mint) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).mints[mint] = { symbol: 'USDC', decimals: 6, tokenProgram: TOKEN };
    expect(() => resolve(config)).toThrow();
  });
  it('rejects mainnet USDC in a devnet profile even if its symbol is changed', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template();
    config.clusters[DEVNET].mints = { [USDC]: { symbol: 'fixture', decimals: 6, tokenProgram: TOKEN } }; expect(() => resolve(config)).toThrow();
  });
  it('accepts a canonical nonzero delegate', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = template(); cluster(config).delegates = [key('delegate')];
    expect(resolve(config).clusters[MAINNET].delegates).toEqual([key('delegate')]);
  });
});

describe('PR2 Jupiter pool config entries', () => {
  const fields = ['ammProgram', 'pool', 'authority', 'mintA', 'mintB', 'vaultA', 'vaultB'] as const;
  function withPool() {
    const config = template(); const pool = poolFixture();
    cluster(config).innerPrograms = [pool.ammProgram]; cluster(config).jupiter.pools = [pool];
    return config;
  }
  it('preserves an exact canonical nonzero seven-key pool entry', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = withPool();
    expect(Object.keys(cluster(config).jupiter.pools[0]).sort()).toEqual([...fields].sort());
    expect(resolve(config).clusters[MAINNET].jupiter.pools).toEqual([poolFixture()]);
  });
  it.each(fields)('rejects pool entry missing %s', (field) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = withPool(); delete cluster(config).jupiter.pools[0][field];
    expect(() => resolve(config)).toThrow();
  });
  it.each(fields.flatMap((field) => [
    [field, 'bad base58 alphabet', '0OIl'], [field, 'noncanonical 32-byte key with extra leading zero', '1' + key('pool-field')], [field, 'zero key', SYSTEM],
  ]))('rejects pool %s with %s', (field, _reason, value) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = withPool(); cluster(config).jupiter.pools[0][field] = value;
    expect(() => resolve(config)).toThrow();
  });
  it('rejects unknown pool entry keys', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = withPool(); cluster(config).jupiter.pools[0].unexpected = true;
    expect(() => resolve(config)).toThrow();
  });
  it('rejects duplicate pool addresses even with different vault metadata', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const config = withPool();
    cluster(config).jupiter.pools.push({ ...poolFixture(), vaultA: key('different-vault') });
    expect(() => resolve(config)).toThrow();
  });
});

describe('PR2 readiness is separate from flag policy and signing availability', () => {
  it('keeps resolveSolanaPolicy output unchanged for a full disabled template', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    expect(() => resolve(template())).not.toThrow();
    expect(resolve(template())).toEqual({ enabled: false, clusters: { [MAINNET]: { enabled: false, killSwitch: false }, [DEVNET]: { enabled: false, killSwitch: false } }, effective: [] });
  });
  // "Required" applies to policy-bearing cluster configs and readiness. PR1 flag-only
  // configs must keep working in resolveSolanaPolicy and startSignerServer.
  it('preserves flag-only effective enablement without imposing readiness', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    expect(resolve({ enabled: true, clusters: { [MAINNET]: { enabled: true, killSwitch: false } } })).toEqual({ enabled: true,
      clusters: { [MAINNET]: { enabled: true, killSwitch: false }, [DEVNET]: { enabled: false, killSwitch: false } }, effective: [MAINNET] });
  });
  it('accepts a full disabled template at startup and EVM still signs without fetch', async () => {
    // Assert successful startup separately so an unknown-config throw cannot look like an intended denial.
    const outcome = await boot(template()).then((h) => ({ h, error: undefined }), (error: unknown) => ({ h: undefined, error }));
    expect(outcome.error).toBeUndefined(); await signEvm(outcome.h!);
  });
  it('pure readiness accepts complete config but startup still refuses enabled Solana', async () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const ready = requireFn(chainModule, 'assertSolanaClusterReady');
    const config = template(); config.enabled = true; cluster(config).enabled = true;
    expect(() => ready(resolve(config), MAINNET)).not.toThrow();
    expect(requireFn(chainModule, 'resolveSolanaPolicy')(config).effective).toEqual([MAINNET]);
    await expect(boot(config)).rejects.toThrow(/solana/i);
  });
  it('readiness accepts enabled config without explicit maxFeeUsd because the default applies', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const ready = requireFn(chainModule, 'assertSolanaClusterReady');
    const config = template(); config.enabled = true; cluster(config).enabled = true; delete cluster(config).fees.maxFeeUsd;
    const normalized = resolve(config);
    expect(normalized.clusters[MAINNET].fees.maxFeeUsd).toBe(PROVISIONAL_SOLANA_POLICY.maxFeeUsdDefault);
    expect(() => ready(normalized, MAINNET)).not.toThrow();
  });
  it('readiness rejects enabled config without maxPerTxUsd independently of parsing', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const ready = requireFn(chainModule, 'assertSolanaClusterReady');
    const config = template(); config.enabled = true; cluster(config).enabled = true;
    const normalized = resolve(config); delete normalized.clusters[MAINNET].maxPerTxUsd;
    if (PROVISIONAL_SOLANA_POLICY.maxPerTxUsdRequired) expect(() => ready(normalized, MAINNET)).toThrow();
    else expect(() => ready(normalized, MAINNET)).not.toThrow();
  });
  it.each([false, true])('keeps flag-only startup compatible with killSwitch=%s and no economic fields', async (killSwitch) => {
    const h = await boot({ enabled: true, clusters: { [MAINNET]: { enabled: false, killSwitch } } });
    await signEvm(h);
  });
  it.each(['maxRentLamports', 'rpcUrls', 'genesisHash', 'price/bounds', 'tokenCaps/native', ...Object.keys(MAINNET_MINTS).map((mint) => `tokenCaps/${mint}`)])('readiness denies missing %s on an enabled cluster', (path) => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const ready = requireFn(chainModule, 'assertSolanaClusterReady');
    const config = template(); config.enabled = true; cluster(config).enabled = true;
    const parts = path.split('/'); const last = parts.pop()!; delete at(cluster(config), parts.join('/'))[last];
    const normalized = resolve(config); expect(() => ready(normalized, MAINNET)).toThrow();
  });
  it('readiness denies empty price bounds', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaConfig'); const ready = requireFn(chainModule, 'assertSolanaClusterReady');
    const config = template(); config.enabled = true; cluster(config).enabled = true; cluster(config).price.bounds = {};
    expect(() => ready(resolve(config), MAINNET)).toThrow();
  });
});
