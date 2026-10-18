/**
 * Proposer-side direct router intents, checked against the live signer
 * decoder and a booted signer. Cronos, Gnosis, and Celo are the venues.
 * Mantle is refused unless pool depth was rechecked.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { buildDirectDexSwap, type DirectDexSwapRequest } from '../../src/bridge/direct-route';
import { decodeCalldata } from '../../src/signer/decode';
import { DEX_VENUES, decodeDexCalldata, type DexVenueConfig } from '../../src/signer/dex-venue';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import type { SignerChainConfig } from '../../src/signer/chain-policy';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const MID = getAddress('0x000000000000000000000000000000000000b00b');
const CAP = '1000000000000000000000';
const QUOTE = 10_000n;
const FLOOR = 9_700n;
const NOW = 1_700_000_000;

const WCRO = '0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23';
const CRONOS_USDC = '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59';
const CRONOS_USDT = '0x66e428c3f67a68878562e79A0234c1F83c208770';
const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
const GNOSIS_USDC = '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0';
const CELO = '0x471EcE3750Da237f93B8E339c536989b8978a438';
const CELO_USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function today(): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}-${day}`;
}

function venue(chainId: number) {
  const found = DEX_VENUES.find((item) => item.chainId === chainId);
  if (!found) throw new Error(`missing venue ${chainId}`);
  return found;
}

function request(chainId: number, patch: Partial<DirectDexSwapRequest> = {}): DirectDexSwapRequest {
  const pinned = venue(chainId);
  const pools: DexVenueConfig['pools'] = chainId === 25
    ? [
      { tokenA: WCRO, tokenB: CRONOS_USDC },
      { tokenA: WCRO, tokenB: CRONOS_USDT },
    ]
    : chainId === 100
      ? [{ tokenA: WXDAI, tokenB: GNOSIS_USDC, fee: 100 }]
      : chainId === 42220
        ? [{ tokenA: CELO, tokenB: CELO_USDT, fee: 100 }]
        : [{ tokenA: pinned.wrappedNative, tokenB: MID, fee: 500 }];
  const tokenIn = chainId === 25 ? WCRO : chainId === 100 ? WXDAI : chainId === 42220 ? CELO : pinned.wrappedNative;
  const tokenOut = chainId === 25 ? CRONOS_USDC : chainId === 100 ? GNOSIS_USDC : chainId === 42220 ? CELO_USDT : MID;
  const dex: DexVenueConfig = {
    enabled: true,
    pools,
    ...(chainId === 5000 ? { poolDepthVerified: true, verifiedAt: today() } : {}),
  };
  return {
    chainId,
    tokenIn,
    tokenOut,
    amountIn: 1000n,
    treasury: WALLET,
    quotedAmountOut: QUOTE,
    dex,
    ...patch,
  };
}

async function boot(chainId: number, dex: DexVenueConfig, tokens: string[], caps?: Record<string, string>) {
  const tokenCaps: Record<string, string> = { native: '0' };
  for (const token of tokens) tokenCaps[getAddress(token)] = CAP;
  const root = await mkdtemp(join(tmpdir(), 'direct-route-'));
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
    simulate: async () => ({ success: true }),
    allow: {
      43114: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      [chainId]: tokens.map((address) => ({ address, selectors: [] as string[], decimals: 18, roles: ['token'] })),
    },
    chains: {
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 1 } },
      },
      [chainId]: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { ...tokenCaps, ...caps },
        price: { prices: { native: 1 } },
        dex,
      } satisfies SignerChainConfig,
    },
  });
  servers.push(server);
  return { server, verifier };
}

async function sign(
  chainId: number,
  data: string,
  to: string,
  intent: { tokenIn: string; tokenOut: string; amountIn: bigint; minAmountOut: bigint; quotedAmountOut: bigint },
  dex: DexVenueConfig,
  extra: Partial<SigningIntent> = {},
  tokens = [intent.tokenIn, intent.tokenOut],
  caps?: Record<string, string>,
) {
  const h = await boot(chainId, dex, tokens, caps);
  const tx: ApprovedTransaction = {
    to: getAddress(to),
    value: '0',
    data,
    chainId,
    nonce: '0',
    gasLimit: '400000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
  const now = Date.now();
  const built: SigningIntent = {
    version: '1',
    intentId: `direct-${chainId}`,
    nonce: '1',
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId,
    venue: 'dex',
    action: 'swap',
    amountIn: intent.amountIn.toString(),
    minAmountOut: intent.minAmountOut.toString(),
    quotedAmountOut: intent.quotedAmountOut.toString(),
    tokenIn: { address: intent.tokenIn, symbol: 'IN', decimals: 18 },
    tokenOut: { address: intent.tokenOut, symbol: 'OUT', decimals: 18 },
    routeHash: computeApprovedTxHash(tx),
    tx,
    ...extra,
  };
  const approval = signVerifierApproval({
    intent: built,
    verifierPrivateKey: h.verifier.privateKey,
    verifierPublicKey: h.verifier.publicKey,
  });
  return h.server.handle({
    requestId: `direct-${chainId}`,
    kind: 'transaction',
    chainId,
    from: WALLET,
    to: getAddress(to),
    value: '0',
    data,
    gasLimit: '400000',
    gasPrice: '1',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'swap',
    structuredIntent: built,
    approval,
  });
}

function policyDecode(
  built: ReturnType<typeof buildDirectDexSwap>,
  dex: DexVenueConfig,
  nowSec = Math.floor(Date.now() / 1000),
) {
  return decodeCalldata(built.to, built.data, {
    wallet: WALLET,
    value: 0n,
    explicitAllows: new Set(),
    tokenIn: built.tokenIn,
    tokenOut: built.tokenOut,
    amountIn: built.amountIn,
    chainId: built.chainId,
    dex,
    nowSec,
    allowAddress: () => true,
    allowSelector: () => false,
    allowRole: (_address, role) => role === 'token',
  });
}

describe('direct router intent builder', () => {
  it('signs Cronos, Gnosis, and Celo swaps the live signer accepts', async () => {
    const cases = [
      { chainId: 25, selector: '0x38ed1739' },
      { chainId: 100, selector: '0x5ae401dc' },
      { chainId: 42220, selector: '0x5ae401dc' },
    ];
    for (const item of cases) {
      const req = request(item.chainId);
      const built = buildDirectDexSwap(req);
      expect(built.to).toBe(venue(item.chainId).router);
      expect(built.value).toBe(0n);
      expect(built.quotedAmountOut).toBe(QUOTE);
      expect(built.minAmountOut).toBe(FLOOR);
      expect(built.data.slice(0, 10).toLowerCase()).toBe(item.selector);
      const decoded = decodeDexCalldata(built.to, built.data, {
        chainId: item.chainId,
        config: req.dex,
        wallet: WALLET,
        value: 0n,
        tokenIn: built.tokenIn,
        tokenOut: built.tokenOut,
        amountIn: built.amountIn,
        allowRole: () => true,
        nowSec: Math.floor(Date.now() / 1000),
      });
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.minOut).toBe(FLOOR);
      const calls = policyDecode(built, req.dex);
      expect(calls[0]).toMatchObject({ kind: 'dex-swap', minOut: FLOOR, amount: 1000n });
      const signed = await sign(item.chainId, built.data, built.to, built, req.dex);
      expect(signed.signedTransaction).toMatch(/^0x/);
    }
  });

  it('matches every hop, including a Cronos path through both documented pools', async () => {
    const req = request(25, { tokenIn: CRONOS_USDC, tokenMid: WCRO, tokenOut: CRONOS_USDT });
    const built = buildDirectDexSwap(req);
    expect(built.data.slice(0, 10).toLowerCase()).toBe('0x38ed1739');
    const calls = policyDecode(built, req.dex);
    expect(calls[0]).toMatchObject({ kind: 'dex-swap', asset: getAddress(CRONOS_USDC) });
    const signed = await sign(25, built.data, built.to, built, req.dex, {}, [CRONOS_USDC, WCRO, CRONOS_USDT]);
    expect(signed.signedTransaction).toMatch(/^0x/);

    const gnosis = request(100, {
      tokenMid: MID,
      dex: {
        enabled: true,
        pools: [
          { tokenA: WXDAI, tokenB: MID, fee: 100 },
          { tokenA: MID, tokenB: GNOSIS_USDC, fee: 100 },
        ],
      },
    });
    const packed = buildDirectDexSwap(gnosis);
    expect(packed.data.slice(0, 10).toLowerCase()).toBe('0x5ae401dc');
    expect(policyDecode(packed, gnosis.dex)[0]?.kind).toBe('dex-swap');
    const h = await boot(100, gnosis.dex, [WXDAI, MID, GNOSIS_USDC]);
    const tx: ApprovedTransaction = {
      to: packed.to,
      value: '0',
      data: packed.data,
      chainId: 100,
      nonce: '0',
      gasLimit: '400000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type: 0,
    };
    const now = Date.now();
    const intent: SigningIntent = {
      version: '1',
      intentId: 'gnosis-hop',
      nonce: '1',
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: WALLET,
      chainId: 100,
      venue: 'dex',
      action: 'swap',
      amountIn: '1000',
      minAmountOut: FLOOR.toString(),
      quotedAmountOut: QUOTE.toString(),
      tokenIn: { address: WXDAI, symbol: 'IN', decimals: 18 },
      tokenOut: { address: GNOSIS_USDC, symbol: 'OUT', decimals: 18 },
      routeHash: computeApprovedTxHash(tx),
      tx,
    };
    const approval = signVerifierApproval({
      intent,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
    });
    const signedHop = await h.server.handle({
      requestId: 'gnosis-hop',
      kind: 'transaction',
      chainId: 100,
      from: WALLET,
      to: packed.to,
      value: '0',
      data: packed.data,
      gasLimit: '400000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'swap',
      structuredIntent: intent,
      approval,
    });
    expect(signedHop.signedTransaction).toMatch(/^0x/);
  });

  it('uses the bought-token class and keeps a minOut above the floor', () => {
    const stable = request(25, {
      slippageCaps: { stables: [CRONOS_USDC], stableBps: 50 },
    });
    expect(buildDirectDexSwap(stable).minAmountOut).toBe(QUOTE * 9950n / 10_000n);
    const tighter = request(25, { maxSlippageBps: 100 });
    expect(buildDirectDexSwap(tighter).minAmountOut).toBe(QUOTE * 9900n / 10_000n);
    const above = request(25, { minAmountOut: QUOTE });
    expect(buildDirectDexSwap(above).minAmountOut).toBe(QUOTE);
    expect(buildDirectDexSwap(request(25, { minAmountOut: FLOOR })).minAmountOut).toBe(FLOOR);
  });

  it('accepts an unordered pool and the single allowlisted fee', () => {
    const swapped = request(100, {
      dex: { enabled: true, pools: [{ tokenA: GNOSIS_USDC, tokenB: WXDAI, fee: 100 }] },
    });
    expect(buildDirectDexSwap(swapped).minAmountOut).toBe(FLOOR);
    const picked = request(100, {
      dex: {
        enabled: true,
        pools: [
          { tokenA: WXDAI, tokenB: GNOSIS_USDC, fee: 100 },
          { tokenA: WXDAI, tokenB: MID, fee: 500 },
        ],
      },
    });
    expect(buildDirectDexSwap(picked).to).toBe(venue(100).router);
  });

  it('refuses Mantle until pool depth is rechecked, then signs', async () => {
    expect(() => buildDirectDexSwap(request(5000, {
      dex: { enabled: true, pools: [{ tokenA: venue(5000).wrappedNative, tokenB: MID, fee: 500 }] },
    }))).toThrow(/pool depth must be rechecked/);
    expect(() => buildDirectDexSwap(request(5000, {
      dex: {
        enabled: true,
        poolDepthVerified: true,
        pools: [{ tokenA: venue(5000).wrappedNative, tokenB: MID, fee: 500 }],
      },
    }))).toThrow(/verifiedAt/);
    expect(() => buildDirectDexSwap(request(5000, {
      dex: {
        enabled: true,
        poolDepthVerified: true,
        verifiedAt: '2099-01-01',
        pools: [{ tokenA: venue(5000).wrappedNative, tokenB: MID, fee: 500 }],
      },
    }))).toThrow(/verifiedAt/);

    const req = request(5000);
    const built = buildDirectDexSwap(req);
    expect(built.value).toBe(0n);
    expect(built.data.slice(0, 10).toLowerCase()).toBe('0x414bf389');
    expect(policyDecode(built, req.dex)[0]?.kind).toBe('dex-swap');
    const signed = await sign(5000, built.data, built.to, built, req.dex);
    expect(signed.signedTransaction).toMatch(/^0x/);
    expect(() => buildDirectDexSwap(request(5000, { multicall: true }))).toThrow(/does not use multicall/);
  });

  it('refuses each direct-route violation', () => {
    const unsupported = {
      tokenIn: WCRO,
      tokenOut: CRONOS_USDC,
      amountIn: 1000n,
      treasury: WALLET,
      quotedAmountOut: QUOTE,
      dex: { enabled: true, pools: [{ tokenA: WCRO, tokenB: CRONOS_USDC }] },
    };
    expect(() => buildDirectDexSwap({ chainId: 146, ...unsupported })).toThrow(/does not support chain 146/);
    expect(() => buildDirectDexSwap({ chainId: 999, ...unsupported })).toThrow(/does not support chain 999/);
    expect(() => buildDirectDexSwap(request(25, { dex: { enabled: false, pools: request(25).dex.pools } }))).toThrow(/disabled/);
    expect(() => buildDirectDexSwap(request(25, { quotedAmountOut: undefined as unknown as bigint }))).toThrow(/quotedAmountOut is required/);
    expect(() => buildDirectDexSwap(request(25, { quotedAmountOut: 0n }))).toThrow(/greater than zero/);
    expect(() => buildDirectDexSwap(request(25, { minAmountOut: FLOOR - 1n }))).toThrow(/slippage floor/);
    expect(() => buildDirectDexSwap(request(25, { tokenOutCap: QUOTE - 1n }))).toThrow(/token cap/);
    expect(() => buildDirectDexSwap(request(25, { maxSlippageBps: 301 }))).toThrow(/slippage cap/);
    expect(() => buildDirectDexSwap(request(25, { tokenOut: MID }))).toThrow(/not allowlisted/);
    expect(() => buildDirectDexSwap(request(100, { fee: 500 }))).toThrow(/not allowlisted/);
    expect(() => buildDirectDexSwap(request(100, {
      tokenMid: MID,
      dex: { enabled: true, pools: [{ tokenA: WXDAI, tokenB: GNOSIS_USDC, fee: 100 }] },
    }))).toThrow(/not allowlisted/);
    expect(() => buildDirectDexSwap(request(100, {
      dex: {
        enabled: true,
        pools: [
          { tokenA: WXDAI, tokenB: GNOSIS_USDC, fee: 100 },
          { tokenA: WXDAI, tokenB: GNOSIS_USDC, fee: 500 },
        ],
      },
    }))).toThrow(/ambiguous/);
    expect(() => buildDirectDexSwap(request(25, { fee: 100 }))).toThrow(/must not set a fee/);
    expect(() => buildDirectDexSwap(request(25, {
      dex: { enabled: true, pools: [{ tokenA: WCRO, tokenB: CRONOS_USDC, fee: 100 }] },
    }))).toThrow(/must not set a fee/);
    expect(() => buildDirectDexSwap(request(100, {
      dex: { enabled: true, pools: [{ tokenA: WXDAI, tokenB: GNOSIS_USDC }] },
    }))).toThrow(/fee tier/);
    expect(() => buildDirectDexSwap(request(25, { dex: { enabled: true, pools: [] } }))).toThrow(/allowlist is empty/);
    expect(() => buildDirectDexSwap(request(25, { sqrtPriceLimitX96: 1n }))).toThrow(/sqrtPriceLimitX96 must be 0/);
    expect(() => buildDirectDexSwap(request(25, { value: 1n }))).toThrow(/value must be 0/);
    expect(() => buildDirectDexSwap(request(25, { nowSec: NOW, deadline: BigInt(NOW) }))).toThrow(/not in the future/);
    expect(() => buildDirectDexSwap(request(25, { nowSec: NOW, deadline: BigInt(NOW + 601) }))).toThrow(/10 minutes/);
    expect(buildDirectDexSwap(request(25, { nowSec: NOW, deadline: BigInt(NOW + 600) })).deadline).toBe(BigInt(NOW + 600));
    expect(() => buildDirectDexSwap(request(25, { multicall: true }))).toThrow(/does not accept multicall/);
    expect(() => buildDirectDexSwap(request(100, { multicall: false }))).toThrow(/timed multicall/);
    expect(() => buildDirectDexSwap(request(25, { dex: { ...request(25).dex, router: MID } }))).toThrow(/pinned router/);
    expect(() => buildDirectDexSwap(request(25, { dex: { ...request(25).dex, wrappedNative: MID } }))).toThrow(/wrapped native/);
  });

  it('refuses trailing bytes, an expired deadline, and an over-cap quote in the signer policy', async () => {
    const req = request(25);
    const built = buildDirectDexSwap(req);
    expect(() => decodeDexCalldata(built.to, `${built.data}00`, {
      chainId: 25,
      config: req.dex,
      wallet: WALLET,
      value: 0n,
      tokenIn: built.tokenIn,
      tokenOut: built.tokenOut,
      amountIn: built.amountIn,
      allowRole: () => true,
      nowSec: NOW,
    })).toThrow(/trailing bytes/);
    expect(() => policyDecode(built, req.dex, Number(built.deadline))).toThrow(/not in the future/);
    expect(() => policyDecode(built, req.dex, Number(built.deadline) - 601)).toThrow(/10 minutes/);
    await expect(sign(25, `${built.data}00`, built.to, built, req.dex)).rejects.toThrow(/trailing/);
    await expect(sign(25, built.data, built.to, built, req.dex, {}, undefined, { [getAddress(CRONOS_USDC)]: '1000' })).rejects.toThrow(/token cap/);
  });
});
