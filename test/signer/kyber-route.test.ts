/**
 * Proposer-side Kyber route wrapped as one Li.Fi V3 leg.
 * The fixture is a recorded KyberSwap Avalanche aggregator route plus build
 * (USDT -> USDC, 100 USDT, recipient = the Li.Fi diamond).
 */
import { describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import { KEY, leg, patchKyber, sign } from '../r8review/helpers';
import { buildKyberLifiSwap, assembleLifiV3FromKyber, type KyberReferenceRequest } from '../../src/bridge/kyber-route';
import { KYBER_ROUTE_CHAINS } from '../../src/bridge/kyber-chains';
import {
  KYBER_META_AGGREGATION_ROUTER_V2,
  KYBER_SWAP_SELECTOR,
  LIFI_DIAMOND,
  LIFI_NATIVE_SENTINEL,
  SELECTOR,
} from '../../src/signer/decode';
import recorded from './fixtures/kyber-avalanche-aggregator.json';

const CHAIN = 43114;
const WALLET = new Wallet(KEY).address;
const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const V3 = new Interface([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
]);

const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cloneFixture(): { route: typeof recorded.route; build: typeof recorded.build } {
  return structuredClone({ route: recorded.route, build: recorded.build });
}

async function buildFrom(
  pair: { route: unknown; build: unknown },
  options: Parameters<typeof buildKyberLifiSwap>[1] = {},
) {
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes('/routes?')) return jsonResponse(pair.route);
    if (url.endsWith('/route/build')) return jsonResponse(pair.build);
    throw new Error(`unexpected ${url}`);
  };
  return buildKyberLifiSwap({
    chainId: CHAIN,
    tokenIn: recorded.request.tokenIn,
    tokenOut: recorded.request.tokenOut,
    amountIn: BigInt(recorded.request.amountIn),
    treasury: WALLET,
  }, { ...options, fetchImpl });
}

describe('Kyber aggregator route as one Li.Fi V3 swap', () => {
  it('signs the recorded Avalanche build with the v2 allowlist', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.includes('/routes?')) return jsonResponse(recorded.route);
      if (url.endsWith('/route/build')) return jsonResponse(recorded.build);
      throw new Error(`unexpected ${url}`);
    };
    const built = await buildKyberLifiSwap({
      chainId: CHAIN,
      tokenIn: recorded.request.tokenIn,
      tokenOut: recorded.request.tokenOut,
      amountIn: BigInt(recorded.request.amountIn),
      treasury: WALLET,
    }, { fetchImpl });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/avalanche/api/v1/routes?');
    const buildBody = JSON.parse(calls[1]?.body ?? '{}') as { sender: string; recipient: string; slippageTolerance: number };
    expect(getAddress(buildBody.sender)).toBe(LIFI_DIAMOND);
    expect(getAddress(buildBody.recipient)).toBe(LIFI_DIAMOND);
    expect(buildBody.slippageTolerance).toBe(50);

    expect(built.to).toBe(LIFI_DIAMOND);
    expect(built.value).toBe(0n);
    expect(built.data.slice(0, 10).toLowerCase()).toBe(SELECTOR.swapTokensSingleV3ERC20ToERC20);
    expect(built.quotedAmountOut).toBe(BigInt(recorded.build.data.amountOut));
    expect(built.minAmountOut).toBe(built.quotedAmountOut * 9950n / 10000n);
    const decoded = V3.decodeFunctionData('swapTokensSingleV3ERC20ToERC20', built.data);
    expect(getAddress(String(decoded[3]))).toBe(getAddress(WALLET));
    expect(BigInt(decoded[4])).toBe(built.minAmountOut);
    const swap = decoded[5] as { callTo: string; callData: string; requiresDeposit: boolean };
    expect(getAddress(swap.callTo)).toBe(KYBER_META_AGGREGATION_ROUTER_V2);
    expect(swap.callData.slice(0, 10).toLowerCase()).toBe(KYBER_SWAP_SELECTOR);
    expect(swap.requiresDeposit).toBe(true);
    expect(built.data.toLowerCase()).not.toContain('332d746b');

    const swapLeg = leg(recorded.build.data.data, {
      sendingAssetId: built.tokenIn,
      receivingAssetId: built.tokenOut,
      fromAmount: built.amountIn,
    });
    const signed = await sign(built.data, [swapLeg], WALLET, {
      amountIn: built.amountIn.toString(),
      minAmountOut: built.minAmountOut.toString(),
      quotedAmountOut: built.quotedAmountOut.toString(),
    });
    expect(signed.signedTransaction).toMatch(/^0x/);
  });

  it('refuses a Kyber recipient other than the Li.Fi diamond', () => {
    expect(() => assembleLifiV3FromKyber({
      chainId: CHAIN,
      calldata: patchKyber(recorded.build.data.data, { dstReceiver: WALLET }),
      quotedAmountOut: BigInt(recorded.build.data.amountOut),
      treasury: WALLET,
    })).toThrow(/Li\.Fi diamond/);
  });

  it('sets native-in value on the ERC-20 V3 selector', () => {
    const calldata = patchKyber(recorded.build.data.data, { srcToken: LIFI_NATIVE_SENTINEL });
    const built = assembleLifiV3FromKyber({
      chainId: CHAIN,
      calldata,
      quotedAmountOut: BigInt(recorded.build.data.amountOut),
      treasury: WALLET,
    });
    expect(built.value).toBe(built.amountIn);
    expect(built.data.slice(0, 10).toLowerCase()).toBe(SELECTOR.swapTokensSingleV3ERC20ToERC20);
  });

  it('refuses a route whose tokenIn, tokenOut, or amountIn is not the request', async () => {
    const tokenIn = cloneFixture();
    tokenIn.route.data.routeSummary.tokenIn = WAVAX;
    await expect(buildFrom(tokenIn)).rejects.toThrow(/route tokenIn/);

    const tokenOut = cloneFixture();
    tokenOut.route.data.routeSummary.tokenOut = WAVAX;
    await expect(buildFrom(tokenOut)).rejects.toThrow(/route tokenOut/);

    const amountIn = cloneFixture();
    amountIn.route.data.routeSummary.amountIn = '1';
    await expect(buildFrom(amountIn)).rejects.toThrow(/route amountIn/);
  });

  it('refuses a build whose amountIn or decoded tokenIn is not the request', async () => {
    const amountIn = cloneFixture();
    amountIn.build.data.amountIn = '1';
    await expect(buildFrom(amountIn)).rejects.toThrow(/build amountIn/);

    const tokenIn = cloneFixture();
    tokenIn.build.data.data = patchKyber(recorded.build.data.data, { srcToken: LIFI_NATIVE_SENTINEL });
    await expect(buildFrom(tokenIn)).rejects.toThrow(/build tokenIn/);
  });

  it('accepts a build amountOut within 0.1% of the route and refuses a wider gap', async () => {
    const under = cloneFixture();
    under.route.data.routeSummary.amountOut = '1000000';
    under.build.data.amountOut = '999000';
    await expect(buildFrom(under)).resolves.toMatchObject({ quotedAmountOut: 999000n });

    const over = cloneFixture();
    over.route.data.routeSummary.amountOut = '1000000';
    over.build.data.amountOut = '1001000';
    await expect(buildFrom(over)).resolves.toMatchObject({ quotedAmountOut: 1001000n });

    const tooLow = cloneFixture();
    tooLow.route.data.routeSummary.amountOut = '1000000';
    tooLow.build.data.amountOut = '998999';
    await expect(buildFrom(tooLow)).rejects.toThrow(/amountOut/);

    const tooHigh = cloneFixture();
    tooHigh.route.data.routeSummary.amountOut = '1000000';
    tooHigh.build.data.amountOut = '1001001';
    await expect(buildFrom(tooHigh)).rejects.toThrow(/amountOut/);
  });

  it('refuses a router or chain that is not the request', async () => {
    const router = cloneFixture();
    router.build.data.routerAddress = '0x000000000000000000000000000000000000dEaD';
    await expect(buildFrom(router)).rejects.toThrow(/build router/);

    const summaryRouter = cloneFixture();
    summaryRouter.route.data.routeSummary.routerAddress = '0x000000000000000000000000000000000000dEaD';
    await expect(buildFrom(summaryRouter)).rejects.toThrow(/route router/);

    const chain = cloneFixture();
    Object.assign(chain.route.data.routeSummary, { chainId: 1 });
    await expect(buildFrom(chain)).rejects.toThrow(/route chain/);

    const buildChain = cloneFixture();
    Object.assign(buildChain.build.data, { chainId: 1 });
    await expect(buildFrom(buildChain)).rejects.toThrow(/build chain/);
  });

  it('builds an understated amountOut when no reference is provided', async () => {
    const pair = cloneFixture();
    const half = BigInt(recorded.build.data.amountOut) / 2n;
    pair.route.data.routeSummary.amountOut = half.toString();
    pair.build.data.amountOut = half.toString();
    await expect(buildFrom(pair)).resolves.toMatchObject({ quotedAmountOut: half });
  });

  it('refuses an amountOut 50% under the reference', async () => {
    const pair = cloneFixture();
    const half = BigInt(recorded.build.data.amountOut) / 2n;
    pair.route.data.routeSummary.amountOut = half.toString();
    pair.build.data.amountOut = half.toString();
    const reference = BigInt(recorded.build.data.amountOut);
    await expect(buildFrom(pair, { referencePrice: reference })).rejects.toThrow(/reference price/);
    await expect(buildFrom(pair, { referencePrice: async () => reference })).rejects.toThrow(/reference price/);
  });

  it('keeps a quote at the 1% floor and refuses one unit under it', async () => {
    const atFloor = cloneFixture();
    atFloor.route.data.routeSummary.amountOut = '9900';
    atFloor.build.data.amountOut = '9900';
    await expect(buildFrom(atFloor, { referencePrice: 10_000n })).resolves.toMatchObject({ quotedAmountOut: 9900n });

    const under = cloneFixture();
    under.route.data.routeSummary.amountOut = '9899';
    under.build.data.amountOut = '9899';
    await expect(buildFrom(under, { referencePrice: 10_000n })).rejects.toThrow(/reference price/);

    const above = cloneFixture();
    above.route.data.routeSummary.amountOut = '10001';
    above.build.data.amountOut = '10001';
    await expect(buildFrom(above, { referencePrice: 10_000n })).resolves.toMatchObject({ quotedAmountOut: 10001n });
  });

  it('passes the requested trade to a reference fetcher', async () => {
    let seen: KyberReferenceRequest | undefined;
    await buildFrom(cloneFixture(), {
      referencePrice: (request) => {
        seen = request;
        return BigInt(recorded.build.data.amountOut);
      },
    });
    expect(seen).toEqual({
      chainId: CHAIN,
      tokenIn: getAddress(recorded.request.tokenIn),
      tokenOut: getAddress(recorded.request.tokenOut),
      amountIn: BigInt(recorded.request.amountIn),
    });
  });

  it('refuses a non-positive reference price', async () => {
    await expect(buildFrom(cloneFixture(), { referencePrice: 0n })).rejects.toThrow(/reference price/);
    await expect(buildFrom(cloneFixture(), { referencePrice: -1n })).rejects.toThrow(/reference price/);
  });
});

const ATTACKER = '0x000000000000000000000000000000000000dEaD';

function retarget(chainId: number) {
  const chain = KYBER_ROUTE_CHAINS.find((entry) => entry.chainId === chainId);
  if (!chain) throw new Error(`missing chain ${chainId}`);
  const pair = cloneFixture();
  pair.route.data.routeSummary.routerAddress = chain.router;
  Object.assign(pair.route.data.routeSummary, { chainId });
  pair.build.data.routerAddress = chain.router;
  Object.assign(pair.build.data, { chainId });
  pair.build.data.data = patchKyber(recorded.build.data.data, { dstReceiver: chain.diamond });
  return { pair, chain };
}

async function buildOn(
  chainId: number,
  pair: { route: unknown; build: unknown },
  extra: { recipient?: string } = {},
  options: Parameters<typeof buildKyberLifiSwap>[1] = {},
) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('/routes?')) return jsonResponse(pair.route);
    if (url.endsWith('/route/build')) return jsonResponse(pair.build);
    throw new Error(`unexpected ${url}`);
  };
  const built = await buildKyberLifiSwap({
    chainId,
    tokenIn: recorded.request.tokenIn,
    tokenOut: recorded.request.tokenOut,
    amountIn: BigInt(recorded.request.amountIn),
    treasury: WALLET,
    ...extra,
  }, { ...options, fetchImpl });
  return { built, calls };
}

describe('Kyber routes on every pinned chain', () => {
  it.each(KYBER_ROUTE_CHAINS)('builds a matching route on $slug ($chainId)', async (chain) => {
    const { pair } = retarget(chain.chainId);
    const { built, calls } = await buildOn(chain.chainId, pair);
    expect(calls[0]?.url).toContain(`/${chain.slug}/api/v1/routes?`);
    const buildBody = JSON.parse(calls[1]?.body ?? '{}') as { sender: string; recipient: string };
    expect(getAddress(buildBody.sender)).toBe(chain.diamond);
    expect(getAddress(buildBody.recipient)).toBe(chain.diamond);
    expect(built.to).toBe(chain.diamond);
    expect(built.wrappedNative).toBe(chain.wrappedNative);
    expect(built.quotedAmountOut).toBe(BigInt(recorded.build.data.amountOut));
    expect(built.minAmountOut).toBe(built.quotedAmountOut * 9950n / 10000n);
    const decoded = V3.decodeFunctionData('swapTokensSingleV3ERC20ToERC20', built.data);
    expect(getAddress(String(decoded[3]))).toBe(getAddress(WALLET));
    const swap = decoded[5] as { callTo: string; callData: string };
    expect(getAddress(swap.callTo)).toBe(chain.router);
    expect(swap.callData.toLowerCase()).toContain(chain.diamond.slice(2).toLowerCase());
  });

  it('refuses a router that is not pinned', async () => {
    const { pair } = retarget(1);
    pair.build.data.routerAddress = ATTACKER;
    await expect(buildOn(1, pair)).rejects.toThrow(/build router/);
  });

  it('refuses a route whose chain is not the request', async () => {
    const { pair } = retarget(1);
    Object.assign(pair.route.data.routeSummary, { chainId: 10 });
    await expect(buildOn(1, pair)).rejects.toThrow(/route chain/);
  });

  it('refuses a recipient that is not the treasury', async () => {
    const { pair } = retarget(8453);
    await expect(buildOn(8453, pair, { recipient: ATTACKER })).rejects.toThrow(/treasury/);
    expect(() => assembleLifiV3FromKyber({
      chainId: 8453,
      calldata: pair.build.data.data,
      quotedAmountOut: BigInt(recorded.build.data.amountOut),
      treasury: WALLET,
      recipient: ATTACKER,
    })).toThrow(/treasury/);
  });

  it('refuses a disabled chain and a chain Kyber does not pin', async () => {
    const ethereum = retarget(1);
    await expect(buildOn(1, ethereum.pair, {}, { enabledChainIds: [43114] })).rejects.toThrow(/disabled chain 1/);
    await expect(buildKyberLifiSwap({
      chainId: 250,
      tokenIn: recorded.request.tokenIn,
      tokenOut: recorded.request.tokenOut,
      amountIn: BigInt(recorded.request.amountIn),
      treasury: WALLET,
    }, { fetchImpl: async () => { throw new Error('fetch must not run'); } })).rejects.toThrow(/does not support chain 250/);
    await expect(buildKyberLifiSwap({
      chainId: 324,
      tokenIn: recorded.request.tokenIn,
      tokenOut: recorded.request.tokenOut,
      amountIn: BigInt(recorded.request.amountIn),
      treasury: WALLET,
    }, { fetchImpl: async () => { throw new Error('fetch must not run'); } })).rejects.toThrow(/does not support chain 324/);
  });

  it('pins Sonic and HyperEVM to the checked router, diamond, and wrapped native', () => {
    const sonic = KYBER_ROUTE_CHAINS.find((entry) => entry.chainId === 146);
    const hyper = KYBER_ROUTE_CHAINS.find((entry) => entry.chainId === 999);
    expect(sonic).toMatchObject({
      slug: 'sonic',
      router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
      diamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      wrappedNative: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',
    });
    expect(hyper).toMatchObject({
      slug: 'hyperevm',
      router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
      diamond: '0x0a0758d937d1059c356D4714e57F5df0239bce1A',
      wrappedNative: '0x5555555555555555555555555555555555555555',
    });
    expect(hyper?.diamond).not.toBe(LIFI_DIAMOND);
  });

  it('refuses a Kyber dstReceiver that is not that chain diamond', () => {
    const { pair, chain } = retarget(80094);
    expect(chain.diamond).not.toBe(LIFI_DIAMOND);
    expect(() => assembleLifiV3FromKyber({
      chainId: 80094,
      calldata: patchKyber(pair.build.data.data, { dstReceiver: ATTACKER }),
      quotedAmountOut: BigInt(recorded.build.data.amountOut),
      treasury: WALLET,
    })).toThrow(/Li\.Fi diamond/);
  });
});
