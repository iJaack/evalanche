/**
 * Per-chain signer policy. An old file with no `chains` object keeps one
 * shared cap map and Avalanche defaults. The new object enables 43114 unless
 * that entry is switched off, and leaves every other mainnet off.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { SIGNER_MAINNET_IDS, signerEnabledByDefault } from '../../src/signer/chain-registry';
import { resolveSignerPolicy } from '../../src/signer/chain-policy';
import { KYBER_META_AGGREGATION_ROUTER_V2, LIFI_DIAMOND, NATIVE_ADDRESS } from '../../src/signer/decode';
import { DEFAULT_AVALANCHE_TOP, DEFAULT_MAX_GAS_COST_WEI } from '../../src/signer/server';
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

  it('does not copy address-keyed caps or the global price source onto chains', () => {
    expect(() => resolveSignerPolicy({
      chains: { 1: { enabled: true } },
      tokenCaps: { native: '1', [USDC]: '5' },
      priceSourceUrl: 'https://prices.example/avax',
    }, BOUNDS)).toThrow(/address-keyed tokenCaps cannot be shared/);

    const policy = resolveSignerPolicy({
      priceSourceUrl: 'https://prices.example/avax',
      chains: {
        1: { enabled: true, tokenCaps: { native: '9' }, price: { prices: { native: 3000 } } },
        43114: { price: { prices: { native: 20 } } },
      },
    }, BOUNDS);
    expect(policy.chains.get(1)?.tokenCaps).toEqual({ native: '9' });
    expect(policy.chains.get(43114)?.tokenCaps).toEqual({});
    expect(policy.chains.get(1)?.localPrices?.[NATIVE_ADDRESS.toLowerCase()]).toBe(3000);
    expect(policy.chains.get(43114)?.localPrices?.[NATIVE_ADDRESS.toLowerCase()]).toBe(20);
    expect(policy.chains.get(1)?.sanitySource).toBeUndefined();
    expect(policy.chains.get(43114)?.sanitySource).toBeUndefined();
  });

  it('accepts a CoinGecko priceFeed and refuses a bad one', () => {
    const fed = resolveSignerPolicy({
      chains: { 43114: { price: { priceFeed: 'coingecko' } } },
    }, BOUNDS);
    expect(fed.chains.get(43114)?.priceFeed).toMatchObject({
      provider: 'coingecko',
      url: 'https://api.coingecko.com/api/v3/simple/price',
    });
    expect(fed.chains.get(1)?.priceFeed).toBeUndefined();
    const bounded = resolveSignerPolicy({
      chains: { 43114: { price: { priceFeed: 'coingecko', bounds: { native: { min: 1, max: 100 } } } } },
    }, BOUNDS);
    expect(bounded.chains.get(43114)?.priceBounds?.[NATIVE_ADDRESS.toLowerCase()]).toEqual({ min: 1, max: 100 });
    expect(() => resolveSignerPolicy({
      chains: { 43114: { price: { bounds: { native: { min: 0, max: 1 } } } } },
    }, BOUNDS)).toThrow(/min must be positive/);
    expect(() => resolveSignerPolicy({
      chains: { 43114: { price: { bounds: { native: { min: 5, max: 1 } } } } },
    }, BOUNDS)).toThrow(/max must be at least min/);

    const withChains = resolveSignerPolicy({
      priceFeed: 'coingecko',
      chains: { 43114: { price: { prices: { native: 1 } } } },
    }, BOUNDS);
    expect(withChains.chains.get(43114)?.priceFeed).toBeUndefined();

    expect(() => resolveSignerPolicy({
      chains: { 43114: { price: { priceFeed: { provider: 'coingecko', url: 'http://api.coingecko.com/api/v3/simple/price' } } } },
    }, BOUNDS)).toThrow(/https/);
    expect(() => resolveSignerPolicy({
      chains: { 43114: { price: { priceFeed: { provider: 'binance' } } } },
    }, BOUNDS)).toThrow(/coingecko/);
    expect(() => resolveSignerPolicy({
      chains: { 43114: { price: { priceFeed: 'coingecko', sanitySource: 'https://prices.example/avax' } } },
    }, BOUNDS)).toThrow(/priceFeed and sanitySource/);
    expect(() => resolveSignerPolicy({
      priceFeed: 'coingecko',
      priceSourceUrl: 'https://prices.example/avax',
    }, BOUNDS)).toThrow(/not both/);
    expect(() => resolveSignerPolicy({
      chains: { 25: { enabled: true, price: { priceFeed: 'coingecko' } } },
    }, BOUNDS)).toThrow(/needs a native coin id/);
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

  function ready(entry: Record<string, unknown> = {}): Record<string, unknown> {
    const gas = { maxFeeUsd: 1, ...((entry.gas as object | undefined) ?? {}) };
    const tokenCaps = {
      native: '0',
      [getAddress(USDC)]: '1000000',
      ...((entry.tokenCaps as object | undefined) ?? {}),
    };
    const price = { prices: { native: 20, [USDC]: 1 }, ...((entry.price as object | undefined) ?? {}) };
    return { ...entry, gas, tokenCaps, price };
  }

  it('rejects a chain that the new config leaves disabled', async () => {
    const h = await boot({ chains: { 43114: ready() } });
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
    const legacy = await boot({ chains: { 43114: ready({ gas: { mode: 'legacy' } }) } });
    const typed = built(legacy.wallet.address, 43114, 2);
    const approval = signVerifierApproval({ intent: typed, verifierPrivateKey: legacy.verifier.privateKey, verifierPublicKey: legacy.verifier.publicKey });
    await expect(legacy.server.handle(request(legacy.wallet.address, 43114, approval, typed))).rejects.toThrow(/transaction type is not allowed/);

    const eip = await boot({ chains: { 43114: ready({ gas: { mode: 'eip1559' } }) } });
    const legacyTx = built(eip.wallet.address, 43114, 0);
    const legacyApproval = signVerifierApproval({ intent: legacyTx, verifierPrivateKey: eip.verifier.privateKey, verifierPublicKey: eip.verifier.publicKey });
    await expect(eip.server.handle(request(eip.wallet.address, 43114, legacyApproval, legacyTx))).rejects.toThrow(/transaction type is not allowed/);

    const both = await boot({ chainId: 43114 });
    const zk = built(both.wallet.address, 43114, 113);
    const zkApproval = signVerifierApproval({ intent: zk, verifierPrivateKey: both.verifier.privateKey, verifierPublicKey: both.verifier.publicKey });
    await expect(both.server.handle(request(both.wallet.address, 43114, zkApproval, zk))).rejects.toThrow(/type 113/);
  });

  it('refuses to start an enabled chain that is missing a cap, a USD gas cap, or a native price', async () => {
    await expect(boot({
      chains: { 43114: { gas: { maxFeeUsd: 1 }, tokenCaps: { [getAddress(USDC)]: '1' }, price: { prices: { native: 1 } } } },
    })).rejects.toThrow(/missing a native cap/);
    await expect(boot({
      chains: { 43114: { gas: { maxFeeUsd: 1 }, tokenCaps: { native: '0' }, price: { prices: { native: 1 } } } },
    })).rejects.toThrow(new RegExp(`missing a cap for ${getAddress(USDC)}`));
    await expect(boot({
      chains: { 43114: { tokenCaps: { native: '0', [getAddress(USDC)]: '1' }, price: { prices: { native: 1 } } } },
    })).rejects.toThrow(/maxFeeUsd must be a positive number/);
    await expect(boot({
      chains: { 43114: { gas: { maxFeeUsd: 1 }, tokenCaps: { native: '0', [getAddress(USDC)]: '1' } } },
    })).rejects.toThrow(/native price or price.sanitySource/);
    const fed = await boot({
      chains: {
        43114: ready(),
        1: { enabled: true, gas: { maxFeeUsd: 2 }, tokenCaps: { native: '0', [getAddress(USDC)]: '1' }, price: { sanitySource: 'https://prices.example/eth' } },
        10: { enabled: false },
      },
    });
    expect(fed.server.address).toMatch(/^0x/);

    await expect(boot({
      chains: {
        43114: {
          gas: { maxFeeUsd: 5 },
          tokenCaps: { native: '0', [getAddress(USDC)]: '1' },
          price: { priceFeed: 'coingecko' },
        },
      },
    })).rejects.toThrow(/native sanity bound/);
    const priced = await boot({
      chains: {
        43114: {
          gas: { maxFeeUsd: 5 },
          tokenCaps: { native: '0', [getAddress(USDC)]: '1' },
          price: { priceFeed: 'coingecko', bounds: { native: { min: 1, max: 100 } } },
        },
      },
    });
    expect(priced.server.address).toMatch(/^0x/);
  });

  it('prices native gas from a CoinGecko fixture and fails closed', async () => {
    const now = Math.floor(Date.now() / 1000);
    let body: unknown = { 'avalanche-2': { usd: 20, last_updated_at: now } };
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('api.coingecko.com')) return original(input, init);
      calls += 1;
      expect(url.startsWith('https://api.coingecko.com/api/v3/simple/price?')).toBe(true);
      expect(url).toContain('ids=avalanche-2');
      expect(url).toContain('vs_currencies=usd');
      expect(url).toContain('include_last_updated_at=true');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const recipient = '0x000000000000000000000000000000000000bEEF';
      const h = await boot({
        priceTtlMs: 0,
        allow: {
          43114: [{ address: recipient, selectors: ['0x'], roles: ['recipient' as const] }],
        },
        chains: {
          43114: {
            gas: { maxFeeUsd: 5 },
            tokenCaps: { native: '0' },
            price: {
              priceFeed: 'coingecko',
              prices: { native: 20 },
              bounds: { native: { min: 5, max: 50 } },
            },
          },
        },
      });
      const send = (nonce: string) => {
        const intent = built(h.wallet.address, 43114, 0, nonce);
        intent.tx!.to = getAddress(recipient);
        intent.tx!.data = '0x';
        intent.routeHash = computeApprovedTxHash(intent.tx!);
        return intent;
      };
      const intent = send('1');
      const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      expect((await h.server.handle(request(h.wallet.address, 43114, approval, intent))).signedTransaction).toMatch(/^0x/);
      expect(calls).toBe(1);

      body = { 'avalanche-2': { usd: 100, last_updated_at: now } };
      const wild = send('2');
      const wildApproval = signVerifierApproval({ intent: wild, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      await expect(h.server.handle(request(h.wallet.address, 43114, wildApproval, wild))).rejects.toThrow(/outside the sanity bound/);

      body = { 'avalanche-2': { usd: 35, last_updated_at: now } };
      const wide = send('3');
      const wideApproval = signVerifierApproval({ intent: wide, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      await expect(h.server.handle(request(h.wallet.address, 43114, wideApproval, wide))).rejects.toThrow(/outside the sanity bound/);

      body = { 'avalanche-2': { usd: 20, last_updated_at: now - 24 * 60 * 60 } };
      const stale = send('4');
      const staleApproval = signVerifierApproval({ intent: stale, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      await expect(h.server.handle(request(h.wallet.address, 43114, staleApproval, stale))).rejects.toThrow(/stale/);

      body = { 'avalanche-2': { usd: '20', last_updated_at: now } };
      const malformed = send('5');
      const malformedApproval = signVerifierApproval({ intent: malformed, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      await expect(h.server.handle(request(h.wallet.address, 43114, malformedApproval, malformed))).rejects.toThrow(/malformed/);

      body = {};
      const missing = send('6');
      const missingApproval = signVerifierApproval({ intent: missing, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
      await expect(h.server.handle(request(h.wallet.address, 43114, missingApproval, missing))).rejects.toThrow(/missing a price/);
      expect(calls).toBe(6);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('prices chain 1 gas in that chain native price and caps the same token address separately', async () => {
    const recipient = '0x000000000000000000000000000000000000bEEF';
    const spender = '0x000000000000000000000000000000000000CAFE';
    const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
    const h = await boot({
      prices: { [NATIVE_ADDRESS]: 20 },
      allow: {
        43114: [
          { address: recipient, selectors: ['0x'], roles: ['recipient' as const] },
          { address: USDC, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token' as const] },
          { address: spender, selectors: ['0x'], roles: ['spender' as const] },
        ],
        1: [
          { address: recipient, selectors: ['0x'], roles: ['recipient' as const] },
          { address: USDC, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token' as const] },
          { address: spender, selectors: ['0x'], roles: ['spender' as const] },
        ],
      },
      chains: {
        43114: ready({ tokenCaps: { native: '0', [getAddress(USDC)]: '10' }, price: { prices: { native: 20 } } }),
        1: ready({
          enabled: true,
          tokenCaps: { native: '0', [getAddress(USDC)]: '1000' },
          price: { prices: { native: 3000 } },
          gas: { maxFeeUsd: 1 },
        }),
      },
    });

    const expensive = built(h.wallet.address, 1, 0);
    expensive.tx!.to = getAddress(recipient);
    expensive.tx!.data = '0x';
    expensive.tx!.gasLimit = '1000000';
    expensive.tx!.gasPrice = '10000000000';
    expensive.routeHash = computeApprovedTxHash(expensive.tx!);
    const costly = signVerifierApproval({ intent: expensive, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 1, costly, expensive))).rejects.toThrow(/gas cost exceeds the USD cap/);

    const cheap = built(h.wallet.address, 43114, 0, '2');
    cheap.tx!.to = getAddress(recipient);
    cheap.tx!.data = '0x';
    cheap.tx!.gasLimit = '1000000';
    cheap.tx!.gasPrice = '10000000000';
    cheap.routeHash = computeApprovedTxHash(cheap.tx!);
    const cheapApproval = signVerifierApproval({ intent: cheap, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    const signed = await h.server.handle(request(h.wallet.address, 43114, cheapApproval, cheap));
    expect(signed.signedTransaction).toMatch(/^0x/);

    const over = built(h.wallet.address, 43114, 0, '3');
    over.tx!.data = erc20.encodeFunctionData('approve', [spender, 100n]);
    over.amountIn = '100';
    over.routeHash = computeApprovedTxHash(over.tx!);
    const overApproval = signVerifierApproval({ intent: over, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 43114, overApproval, over))).rejects.toThrow(/per-transaction cap/);

    const room = built(h.wallet.address, 1, 0, '4');
    room.tx!.data = erc20.encodeFunctionData('approve', [spender, 100n]);
    room.amountIn = '100';
    room.routeHash = computeApprovedTxHash(room.tx!);
    const roomApproval = signVerifierApproval({ intent: room, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    const approved = await h.server.handle(request(h.wallet.address, 1, roomApproval, room));
    expect(approved.signedTransaction).toMatch(/^0x/);
  });

  it('rejects an approval signed for one chain when it is presented on another, and a reused nonce', async () => {
    const recipient = '0x000000000000000000000000000000000000bEEF';
    const h = await boot({
      allow: {
        43114: [{ address: recipient, selectors: ['0x'], roles: ['recipient' as const] }],
        1: [{ address: recipient, selectors: ['0x'], roles: ['recipient' as const] }],
      },
      chains: {
        43114: ready({ tokenCaps: { native: '0' } }),
        1: ready({ enabled: true, tokenCaps: { native: '0' }, price: { prices: { native: 3000 } } }),
      },
    });
    const intent = built(h.wallet.address, 43114, 0, '1');
    intent.tx!.to = getAddress(recipient);
    intent.tx!.data = '0x';
    intent.routeHash = computeApprovedTxHash(intent.tx!);
    const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 1, approval, intent))).rejects.toThrow(/chainId does not match/);

    const signed = await h.server.handle(request(h.wallet.address, 43114, approval, intent));
    expect(signed.signedTransaction).toMatch(/^0x/);

    const other = built(h.wallet.address, 1, 0, '1');
    other.tx!.to = getAddress(recipient);
    other.tx!.data = '0x';
    other.routeHash = computeApprovedTxHash(other.tx!);
    const otherApproval = signVerifierApproval({ intent: other, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle(request(h.wallet.address, 1, otherApproval, other))).rejects.toThrow(/Replayed nonce/);
  });
});

describe('live Avalanche config snapshot', () => {
  const usdc = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  const wavax = DEFAULT_AVALANCHE_TOP[0]!;
  const btcb = DEFAULT_AVALANCHE_TOP[1]!;
  const weth = DEFAULT_AVALANCHE_TOP[2]!;
  const savax = DEFAULT_AVALANCHE_TOP[3]!;
  const treasury = '0x0000000000000000000000000000000000000001';

  it('keeps the legacy file on 43114 without a USD gas cap or a per-chain price', async () => {
    const input = {
      chainId: 43114,
      rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
      tokenCaps: {
        native: '0',
        [usdc]: '1000',
        [wavax]: '1000',
        [btcb]: '1000',
        [weth]: '1000',
        [savax]: '1000',
      },
    };
    const policy = resolveSignerPolicy(input, BOUNDS);
    expect(policy.legacy).toBe(true);
    expect(policy.enabled).toEqual([43114]);
    const chain = policy.chains.get(43114)!;
    expect(chain.gasMode).toBe('both');
    expect(chain.maxFeeWei).toBe(DEFAULT_MAX_GAS_COST_WEI);
    expect(chain.maxFeeUsd).toBeUndefined();
    expect(chain.tokenCaps.native).toBe('0');
    expect(chain.tokenCaps[getAddress(usdc)]).toBe('1000');
    expect(chain.tokenCaps[getAddress(wavax)]).toBe('1000');
    expect(chain.avalancheSlippageDefaults).toBe(true);
    expect(chain.kyberExecutors).toBeUndefined();
    expect(chain.polymarket).toBeUndefined();
    expect(chain.clmm).toBeUndefined();
    expect(chain.sanitySource).toBeUndefined();
    expect(chain.rpcUrls).toEqual(['https://api.avax.network/ext/bc/C/rpc']);

    const root = await mkdtemp(join(tmpdir(), 'live-'));
    const verifier = generateEd25519KeyPair();
    const server = await startSignerServer({
      ...input,
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
        43114: [
          { address: usdc, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token'] },
          { address: wavax, selectors: ['0x095ea7b3'], decimals: 18, roles: ['token'] },
          { address: btcb, selectors: ['0x095ea7b3'], decimals: 8, roles: ['token'] },
          { address: weth, selectors: ['0x095ea7b3'], decimals: 18, roles: ['token'] },
          { address: savax, selectors: ['0x095ea7b3'], decimals: 18, roles: ['token'] },
          { address: LIFI_DIAMOND, selectors: ['0x4666fc80', '0x5fd9ae2e'], roles: ['spender'] },
          { address: KYBER_META_AGGREGATION_ROUTER_V2, selectors: [], roles: ['dex', 'spender'] },
          { address: treasury, selectors: ['0x'], roles: ['recipient'] },
        ],
      },
    });
    servers.push(server);
    expect(server.address).toMatch(/^0x/);
  });
});
