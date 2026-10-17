/**
 * Proposer-side Kyber route wrapped as one Li.Fi V3 leg.
 * The fixture is a recorded KyberSwap Avalanche aggregator route plus build
 * (USDT -> USDC, 100 USDT, recipient = the Li.Fi diamond).
 */
import { describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import { KEY, leg, patchKyber, sign } from '../r8review/helpers';
import { buildKyberLifiSwap, assembleLifiV3FromKyber } from '../../src/bridge/kyber-route';
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
});
