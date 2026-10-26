import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Transaction } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chainModule from '../../src/signer/chain-policy';
import * as intentModule from '../../src/signer/intent';
import * as serverModule from '../../src/signer/server';
import {
  CLUSTERS, LABELS, deriveKey, makeEvmIntent, makeIntent, makeRequest, referenceApproval, requireFn, sha256,
} from './solana-test-helpers';

const servers: Array<{ close: () => Promise<void> }> = [];
const roots: string[] = [];
afterEach(async () => {
  try { while (servers.length) await servers.pop()!.close(); }
  finally {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  }
});
const combinations = [false, true].flatMap((enabled) => [false, true].flatMap((clusterEnabled) => [false, true].map((killSwitch) => ({ enabled, clusterEnabled, killSwitch }))));
function noFetch() {
  const fetch = vi.fn(async () => { throw new Error('offline PR1 test unexpectedly fetched'); });
  vi.stubGlobal('fetch', fetch); return fetch;
}
async function boot(extra: Record<string, unknown> = {}) {
  const start = requireFn(serverModule, 'startSignerServer');
  const root = await mkdtemp(join(tmpdir(), 'solana-pr1-')); roots.push(root);
  const verifier = deriveKey(LABELS.verifier);
  const wallet = new Wallet('0x' + sha256('evalanche-test-only/solana-pr1/evm-wallet').toString('hex'));
  const recipient = makeEvmIntent().tx.to;
  const server = await start({
    privateKey: wallet.privateKey, verifierPublicKey: verifier.publicHex, token: 'test-token',
    auditLogPath: join(root, 'audit.jsonl'), nonceStorePath: join(root, 'nonces.json'),
    initNonces: true, allowInsecureFilePermissions: true, chainId: 43114, port: 0,
    allow: { 43114: [{ address: recipient, selectors: ['0x'], roles: ['recipient'] }] },
    simulate: async () => ({ success: true }), ...extra,
  });
  servers.push(server); return { server, verifier, wallet };
}
async function bootAccepted(extra: Record<string, unknown> = {}) {
  const outcome = await boot(extra).then(
    (harness) => ({ harness, error: undefined }),
    (error: unknown) => ({ harness: undefined, error }),
  );
  expect(outcome.error, 'an absent or ineffective Solana policy must allow EVM startup').toBeUndefined();
  return outcome.harness!;
}
async function signEvm(h: Awaited<ReturnType<typeof boot>>) {
  const intent = makeEvmIntent(); const now = Date.now();
  intent.wallet = h.wallet.address; intent.createdAt = now; intent.expiresAt = now + 60000;
  const sign = requireFn(intentModule, 'signVerifierApproval');
  const approval = sign({ intent, verifierPrivateKey: h.verifier.seedHex, verifierPublicKey: h.verifier.publicHex });
  const tx = intent.tx;
  const result = await h.server.handle({ requestId: 'evm-still-signs', kind: 'transaction', chainId: 43114,
    from: intent.wallet, intent: 'Synthetic EVM zero-value transfer', structuredIntent: intent, approval,
    ...tx, nonce: Number(tx.nonce) });
  expect(result.signedTransaction).toMatch(/^0x/);
  const signed = Transaction.from(result.signedTransaction);
  expect(signed.from).toBe(h.wallet.address); expect(signed.chainId).toBe(43114n);
  expect(signed.to).toBe(tx.to); expect(signed.value).toBe(0n); expect(signed.data).toBe('0x');
}

describe('PR1 pure Solana flag resolver', () => {
  it('defaults absent policy to fully off', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    expect(resolve(undefined)).toEqual({ enabled: false, clusters: {
      'solana:mainnet': { enabled: false, killSwitch: false },
      'solana:devnet': { enabled: false, killSwitch: false },
    }, effective: [] });
  });
  it('accepts the minimal disabled policy and fills missing cluster flags false', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    expect(resolve({ enabled: false, clusters: {} })).toEqual(resolve(undefined));
  });
  for (const cluster of CLUSTERS) {
    it.each(combinations)('resolves ' + cluster + ' flags $enabled/$clusterEnabled/$killSwitch', ({ enabled, clusterEnabled, killSwitch }) => {
      const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
      const result = resolve({ enabled, clusters: { [cluster]: { enabled: clusterEnabled, killSwitch } } });
      expect(result.enabled).toBe(enabled);
      expect(result.clusters[cluster]).toEqual({ enabled: clusterEnabled, killSwitch });
      expect(result.effective).toEqual(enabled && clusterEnabled && !killSwitch ? [cluster] : []);
      const other = CLUSTERS.find((name) => name !== cluster)!;
      expect(result.clusters[other]).toEqual({ enabled: false, killSwitch: false });
    });
  }
  it('keeps both enabled clusters distinct', () => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    const effective = resolve({ enabled: true, clusters: { 'solana:devnet': { enabled: true }, 'solana:mainnet': { enabled: true } } }).effective;
    expect(effective).toHaveLength(2); expect(effective).toEqual(expect.arrayContaining(CLUSTERS));
  });
  it.each([
    null, [], true, 'enabled',
    { enabled: false, clusters: {}, unknown: true },
    { enabled: false, clusters: { 'solana:mainnet': { unknown: true } } },
    ...['solana:testnet', 'Solana:mainnet', 'solana:mainnet\0', '43114'].map((cluster) => ({ enabled: false, clusters: { [cluster]: {} } })),
    ...['true', 1, null, {}, []].flatMap((flag) => [
      { enabled: flag, clusters: {} },
      { enabled: false, clusters: { 'solana:mainnet': { enabled: flag } } },
      { enabled: false, clusters: { 'solana:devnet': { killSwitch: flag } } },
    ]),
    { enabled: false, clusters: [] }, { enabled: false, clusters: null },
    { enabled: false, clusters: { 'solana:mainnet': null } },
  ])('rejects malformed dormant policy %j', (policy) => {
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    expect(() => resolve(policy)).toThrow();
  });
  for (const level of ['solana', 'clusters', 'cluster']) {
    it.each(['__proto__', 'constructor', 'prototype'])('rejects %s config key at ' + level, (key) => {
      const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
      const policy = { enabled: false, clusters: { 'solana:mainnet': { enabled: false } } };
      const target = level === 'solana' ? policy : level === 'clusters' ? policy.clusters : policy.clusters['solana:mainnet'];
      Object.defineProperty(target, key, { value: true, enumerable: true });
      expect(() => resolve(policy)).toThrow();
    });
  }
});

describe('PR1 startup and unreachable Solana path', () => {
  it('preserves EVM signing when Solana is absent and performs no fetch', async () => {
    const fetch = noFetch(); const h = await bootAccepted(); await signEvm(h); expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts the minimal top-level disabled Solana object and preserves EVM signing', async () => {
    const fetch = noFetch(); const h = await bootAccepted({ solana: { enabled: false, clusters: {} } });
    await signEvm(h); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(combinations.filter(({ enabled, clusterEnabled, killSwitch }) => !(enabled && clusterEnabled && !killSwitch)))('starts with ineffective flags $enabled/$clusterEnabled/$killSwitch and EVM still signs', async ({ enabled, clusterEnabled, killSwitch }) => {
    const fetch = noFetch();
    const h = await bootAccepted({ solana: { enabled, clusters: { 'solana:mainnet': { enabled: clusterEnabled, killSwitch } } } });
    await signEvm(h); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(CLUSTERS)('refuses effectively enabled %s because the PR1 signer is incomplete', async (cluster) => {
    const fetch = noFetch();
    // Guard against a false green caused merely by rejecting the whole unknown solana key.
    const resolve = requireFn(chainModule, 'resolveSolanaPolicy');
    const solana = { enabled: true, clusters: { [cluster]: { enabled: true, killSwitch: false } } };
    expect(resolve(solana).effective).toEqual([cluster]);
    await expect(boot({ solana })).rejects.toThrow(/solana/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['absent', 'off'])('denies a Solana request with %s config before fetch, and EVM still signs', async (state) => {
    const fetch = noFetch(); const h = await bootAccepted(state === 'absent' ? {} : { solana: { enabled: false, clusters: {} } });
    const request = makeRequest(makeIntent()); request.approval = referenceApproval(request.structuredIntent);
    // Direct handle follows existing signer tests and keeps this probe entirely offline.
    const rejection = await h.server.handle(request).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/solana/i);
    expect((rejection as Error).message).toMatch(/disabled|not enabled|off/i);
    expect(fetch).not.toHaveBeenCalled();
    await signEvm(h); expect(fetch).not.toHaveBeenCalled();
  });
  // EVALANCHE_SIGNER_SOLANA_SECRET_KEY belongs to PR2; do not mutate the real process environment here.
});
