/**
 * Per-chain signer policy. An old file with no `chains` object keeps one
 * shared cap map and Avalanche defaults. The new object enables 43114 unless
 * that entry is switched off, and leaves every other mainnet off.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { SIGNER_MAINNET_IDS, signerEnabledByDefault } from '../../src/signer/chain-registry';
import { resolveSignerPolicy } from '../../src/signer/chain-policy';
import { CHAINS } from '../../src/utils/chains';
import { computeApprovedTxHash, signVerifierApproval } from '../../src/signer/intent';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';

const BOUNDS = { defaultMaxFeeWei: 20_000_000_000_000_000n, hardMaxFeeWei: 10n ** 18n };
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

describe('chain policy', () => {
  it('keeps an old single-chain file on 43114 with shared caps', () => {
    const policy = resolveSignerPolicy({
      chainId: 43114,
      rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
      tokenCaps: { [USDC]: '10', native: '5' },
      maxGasCostWei: '1000',
      priceSourceUrl: 'https://prices.example/feed',
      slippageCaps: { otherBps: 300 },
    }, BOUNDS);
    expect(policy.legacy).toBe(true);
    expect(policy.enabled).toEqual([43114]);
    const chain = policy.chains.get(43114)!;
    expect(chain.gasMode).toBe('both');
    expect(chain.maxFeeWei).toBe(1000n);
    expect(chain.tokenCaps[getAddress(USDC)]).toBe('10');
    expect(chain.tokenCaps.native).toBe('5');
    expect(chain.avalancheSlippageDefaults).toBe(true);
    expect(chain.rpcUrls).toEqual(['https://api.avax.network/ext/bc/C/rpc']);
    expect(chain.sanitySource).toBe('https://prices.example/feed');
    expect(chain.kyberExecutors).toBeUndefined();
    expect(chain.polymarket).toBeUndefined();
    expect(chain.clmm).toBeUndefined();
  });

  it('refuses a testnet in an old chain list', () => {
    expect(() => resolveSignerPolicy({ chainIds: [43114, 43113] }, BOUNDS)).toThrow(/testnet 43113/);
  });

  it('enables only 43114 when the chains object omits flags', () => {
    const policy = resolveSignerPolicy({ chains: { 10: {}, 137: { enabled: false } } }, BOUNDS);
    expect(policy.legacy).toBe(false);
    expect(policy.enabled).toEqual([43114]);
    expect(policy.chains.get(10)?.enabled).toBe(false);
    expect(policy.chains.get(10)?.kyberExecutors).toEqual([]);
    expect(policy.chains.get(10)?.avalancheSlippageDefaults).toBe(false);
  });

  it('turns a mainnet on only with enabled, and a kill switch wins', () => {
    const on = resolveSignerPolicy({
      chains: { 137: { enabled: true, rpcUrls: ['https://polygon.example/a', 'https://polygon.example/b'] } },
    }, BOUNDS);
    expect(on.enabled.sort((a, b) => a - b)).toEqual([137, 43114]);
    expect(on.chains.get(137)?.rpcUrls).toEqual(['https://polygon.example/a', 'https://polygon.example/b']);

    const killed = resolveSignerPolicy({ chains: { 43114: { killSwitch: true, enabled: true } } }, BOUNDS);
    expect(killed.enabled).toEqual([]);
    expect(killed.chains.get(43114)?.enabled).toBe(false);

    const off = resolveSignerPolicy({ chains: { 43114: { enabled: false } } }, BOUNDS);
    expect(off.enabled).toEqual([]);
  });

  it('keys token caps by chain so one address does not share a cap', () => {
    const policy = resolveSignerPolicy({
      chains: { 137: { enabled: true } },
      tokenCaps: {
        43114: { [USDC]: '5', native: '1' },
        137: { [USDC]: '90' },
      },
    }, BOUNDS);
    expect(policy.chains.get(43114)?.tokenCaps[getAddress(USDC)]).toBe('5');
    expect(policy.chains.get(137)?.tokenCaps[getAddress(USDC)]).toBe('90');
    expect(policy.chains.get(137)?.tokenCaps.native).toBeUndefined();
  });

  it('rejects a mixed cap shape, a non-https price, a bad gas mode, and an unknown chain', () => {
    expect(() => resolveSignerPolicy({ tokenCaps: { native: '1', 43114: { native: '2' } } }, BOUNDS)).toThrow(/tokenCaps/);
    expect(() => resolveSignerPolicy({ chains: { 43114: { price: { sanitySource: 'http://insecure' } } } }, BOUNDS)).toThrow(/https/);
    expect(() => resolveSignerPolicy({ chains: { 43114: { gas: { mode: 'blob' as 'legacy' } } } }, BOUNDS)).toThrow(/mode/);
    expect(() => resolveSignerPolicy({ chains: { 999999: { enabled: true } } }, BOUNDS)).toThrow(/not one of the signer mainnets/);
    expect(() => resolveSignerPolicy({ chains: { 43113: { enabled: true } } }, BOUNDS)).toThrow(/testnet/);
  });

  it('stores per-chain gas policy and rpc lists', () => {
    const policy = resolveSignerPolicy({
      rpcUrls: { 43114: ['https://avax.example/1'] },
      chains: {
        43114: { gas: { mode: 'legacy', maxFeeWei: '42', maxFeeUsd: 1.5 } },
        137: { enabled: true, gas: { mode: 'eip1559', maxFeeWei: '7' }, rpcUrls: ['https://polygon.example'] },
      },
    }, BOUNDS);
    expect(policy.chains.get(43114)?.gasMode).toBe('legacy');
    expect(policy.chains.get(43114)?.maxFeeWei).toBe(42n);
    expect(policy.chains.get(43114)?.maxFeeUsd).toBe(1.5);
    expect(policy.chains.get(43114)?.rpcUrls).toEqual(['https://avax.example/1']);
    expect(policy.chains.get(137)?.gasMode).toBe('eip1559');
    expect(policy.chains.get(137)?.rpcUrls).toEqual(['https://polygon.example']);
  });

  it('registers the nineteen mainnets and enables only Avalanche by default', () => {
    expect(SIGNER_MAINNET_IDS).toHaveLength(19);
    const defaults = SIGNER_MAINNET_IDS.filter((id) => signerEnabledByDefault(id));
    expect(defaults).toEqual([43114]);
    expect(CHAINS[43114]?.signerEnabledByDefault).toBe(true);
    for (const id of SIGNER_MAINNET_IDS) {
      if (id !== 43114) expect(CHAINS[id]?.signerEnabledByDefault).toBeUndefined();
    }
  });
});

describe('chain policy on the signer', () => {
  const allow = {
    43114: [{ address: USDC, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token' as const] }],
    1: [{ address: USDC, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token' as const] }],
  };

  async function boot(extra: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'chain-'));
    const verifier = generateEd25519KeyPair();
    const server = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a.jsonl'),
      nonceStorePath: join(root, 'n.json'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      port: 0,
      allow,
      simulate: async () => ({ success: true }),
      ...extra,
    });
    servers.push(server);
    return { server, verifier, wallet: new Wallet(KEY) };
  }

  function request(wallet: string, chainId: number, approval: ReturnType<typeof signVerifierApproval>, built: SigningIntent): CanonicalSigningRequest {
    const tx = built.tx!;
    return {
      requestId: 'r',
      kind: 'transaction',
      chainId,
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

  function built(wallet: string, chainId: number, type: number, nonce = '1'): SigningIntent {
    const tx: ApprovedTransaction = {
      to: getAddress(USDC),
      value: '0',
      data: '0x095ea7b3',
      chainId,
      nonce,
      gasLimit: '21000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type,
    };
    const now = Date.now();
    return {
      version: '1',
      intentId: 'i',
      nonce,
      createdAt: now,
      expiresAt: now + 60_000,
      wallet,
      chainId,
      venue: 'avalanche',
      action: 'approve',
      amountIn: '0',
      routeHash: computeApprovedTxHash(tx),
      tx,
      tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    };
  }

  it('rejects a chain that the new config leaves disabled', async () => {
    const h = await boot({ chains: {} });
    const intent = built(h.wallet.address, 1, 0);
    const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 1, approval, intent))).rejects.toThrow(/chainId 1 is not allowed/);
  });

  it('rejects Avalanche when the kill switch is on', async () => {
    const h = await boot({ chains: { 43114: { killSwitch: true } } });
    const intent = built(h.wallet.address, 43114, 0);
    const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 43114, approval, intent))).rejects.toThrow(/chainId 43114 is not allowed/);
  });

  it('rejects a type that the chain gas mode does not allow, including type 113', async () => {
    const legacy = await boot({ chains: { 43114: { gas: { mode: 'legacy' } } } });
    const typed = built(legacy.wallet.address, 43114, 2);
    const approval = signVerifierApproval({ intent: typed, verifierPrivateKey: legacy.verifier.privateKey, verifierPublicKey: legacy.verifier.publicKey });
    await expect(legacy.server.handle(request(legacy.wallet.address, 43114, approval, typed))).rejects.toThrow(/transaction type is not allowed/);

    const eip = await boot({ chains: { 43114: { gas: { mode: 'eip1559' } } } });
    const legacyTx = built(eip.wallet.address, 43114, 0);
    const legacyApproval = signVerifierApproval({ intent: legacyTx, verifierPrivateKey: eip.verifier.privateKey, verifierPublicKey: eip.verifier.publicKey });
    await expect(eip.server.handle(request(eip.wallet.address, 43114, legacyApproval, legacyTx))).rejects.toThrow(/transaction type is not allowed/);

    const both = await boot({ chainId: 43114 });
    const zk = built(both.wallet.address, 43114, 113);
    const zkApproval = signVerifierApproval({ intent: zk, verifierPrivateKey: both.verifier.privateKey, verifierPublicKey: both.verifier.publicKey });
    await expect(both.server.handle(request(both.wallet.address, 43114, zkApproval, zk))).rejects.toThrow(/type 113/);
  });
});
