/**
 * Same-chain swap built from the KyberSwap aggregator, wrapped as one
 * Li.Fi GenericSwapFacetV3 call.
 *
 * Real Li.Fi quotes insert a "LIFI Fixed Fee" step (selector `0x332d746b`)
 * ahead of Kyber. That step stays off the allowlist. This builder never
 * calls the Li.Fi API. It asks Kyber for route and build calldata, then
 * encodes a single `swapTokensSingleV3ERC20ToERC20` (`0x4666fc80`).
 *
 * Kyber's `sender` and `recipient` are the Li.Fi diamond. The diamond is
 * `msg.sender` on the router and the address whose balance V3 measures.
 * The treasury wallet is the V3 `receiver`, which the signer requires to
 * be the signing wallet and an allowlisted recipient.
 */

import { Interface, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
import {
  KYBER_META_AGGREGATION_ROUTER_V2,
  KYBER_SWAP_SELECTOR,
  LIFI_DIAMOND,
  LIFI_NATIVE_SENTINEL,
  SELECTOR,
  isNativeAsset,
} from '../signer/decode';
import { tokenClassBps, type SlippageCaps } from '../signer/server';

export const KYBER_AGGREGATOR_API = 'https://aggregator-api.kyberswap.com';

const CHAIN_SLUG: Record<number, string> = {
  43114: 'avalanche',
};

const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';

const LIFI_V3 = new Interface([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
]);

const KYBER = new Interface([
  'function swap((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);

export interface KyberLifiSwapRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** V3 receiver. Must be the signer wallet when the tx is submitted. */
  treasury: string;
  slippageCaps?: SlippageCaps;
}

export interface KyberLifiSwap {
  chainId: number;
  /** Li.Fi diamond. */
  to: string;
  /** `0x4666fc80` GenericSwapFacetV3 calldata. */
  data: string;
  /** Native-in value. Zero for an ERC-20 sell. */
  value: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}

interface KyberEnvelope {
  code?: number;
  message?: string;
  data?: {
    routeSummary?: unknown;
    routerAddress?: string;
    amountOut?: string;
    data?: string;
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface KyberLifiSwapOptions {
  /** Test double. Production uses {@link safeFetch}. */
  fetchImpl?: FetchLike;
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_PARAMS);
}

function chainSlug(chainId: number): string {
  const slug = CHAIN_SLUG[chainId];
  if (!slug) fail(`Kyber route builder does not support chain ${chainId}`);
  return slug;
}

/** Kyber and Li.Fi both use the `0xeeee…` sentinel for native. */
function aggregatorToken(token: string): string {
  if (isNativeAsset(token)) return LIFI_NATIVE_SENTINEL;
  try {
    return getAddress(token);
  } catch {
    fail(`Kyber token is not an address: ${token}`);
  }
}

function classFloor(quoted: bigint, tokenOut: string, caps: SlippageCaps | undefined): bigint {
  if (quoted <= 0n) fail('Kyber amountOut must be greater than zero');
  const bps = tokenClassBps(caps, tokenOut);
  const floor = quoted * (10_000n - BigInt(bps)) / 10_000n;
  if (floor <= 0n) fail('Kyber amountOut is too small to leave a positive slippage floor');
  return floor;
}

async function readKyber(url: string, init: RequestInit, fetchImpl?: FetchLike): Promise<KyberEnvelope> {
  const response = fetchImpl
    ? await fetchImpl(url, init)
    : await safeFetch(url, { ...init, timeoutMs: 20_000, maxBytes: 2_000_000 });
  if (!response.ok) {
    throw new EvalancheError(`Kyber aggregator HTTP ${response.status}`, EvalancheErrorCode.NETWORK_ERROR);
  }
  let body: KyberEnvelope;
  try {
    body = await response.json() as KyberEnvelope;
  } catch (error) {
    throw new EvalancheError(
      'Kyber aggregator returned malformed JSON',
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
  if (body.code !== 0 || !body.data) {
    throw new EvalancheError(
      `Kyber aggregator rejected the request: ${body.message ?? 'unknown error'}`,
      EvalancheErrorCode.NETWORK_ERROR,
    );
  }
  return body;
}

/**
 * Wrap Kyber `swap` calldata as one GenericSwapFacetV3 ERC-20 leg.
 * Native-in is encoded on that same selector with `value === fromAmount`,
 * which the signer already allows. Native V3 selectors are not used.
 * `quotedAmountOut` is Kyber's `amountOut`. `minAmountOut` is that quote
 * times one minus the bought-token class cap.
 */
export function assembleLifiV3FromKyber(input: {
  chainId: number;
  calldata: string;
  quotedAmountOut: bigint;
  treasury: string;
  slippageCaps?: SlippageCaps;
}): KyberLifiSwap {
  const chainId = input.chainId;
  chainSlug(chainId);
  let treasury: string;
  try {
    treasury = getAddress(input.treasury);
  } catch {
    fail('treasury is not an address');
  }
  if (input.calldata.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) {
    fail('Kyber router selector is not swap');
  }
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = KYBER.decodeFunctionData('swap', input.calldata);
  } catch {
    fail('Kyber swap calldata could not be decoded');
  }
  const execution = decoded[0];
  const again = KYBER.encodeFunctionData('swap', [execution]);
  if (again.toLowerCase() !== input.calldata.toLowerCase()) {
    fail('Kyber swap calldata has trailing bytes');
  }
  const desc = execution.desc as {
    srcToken: string;
    dstToken: string;
    dstReceiver: string;
    amount: bigint;
    feeAmounts: readonly bigint[];
  };
  const diamond = getAddress(LIFI_DIAMOND);
  let dstReceiver: string;
  try {
    dstReceiver = getAddress(String(desc.dstReceiver));
  } catch {
    fail('Kyber dstReceiver is not an address');
  }
  if (dstReceiver !== diamond) {
    fail('Kyber recipient must be the Li.Fi diamond so the V3 facet can measure the output');
  }
  for (const amount of desc.feeAmounts) {
    if (BigInt(amount) !== 0n) fail('Kyber fee amount must be zero');
  }
  const amountIn = BigInt(desc.amount);
  if (amountIn <= 0n) fail('Kyber swap amount must be greater than zero');
  const tokenIn = String(desc.srcToken);
  const tokenOut = String(desc.dstToken);
  const nativeIn = isNativeAsset(tokenIn);
  const minAmountOut = classFloor(input.quotedAmountOut, isNativeAsset(tokenOut) ? tokenOut : getAddress(tokenOut), input.slippageCaps);
  const router = getAddress(KYBER_META_AGGREGATION_ROUTER_V2);
  const data = LIFI_V3.encodeFunctionData('swapTokensSingleV3ERC20ToERC20', [
    `0x${'00'.repeat(32)}`,
    'evalanche',
    '',
    treasury,
    minAmountOut,
    {
      callTo: router,
      approveTo: router,
      sendingAssetId: tokenIn,
      receivingAssetId: tokenOut,
      fromAmount: amountIn,
      callData: input.calldata,
      requiresDeposit: true,
    },
  ]);
  if (data.slice(0, 10).toLowerCase() !== SELECTOR.swapTokensSingleV3ERC20ToERC20) {
    fail('Li.Fi V3 selector was not swapTokensSingleV3ERC20ToERC20');
  }
  return {
    chainId,
    to: diamond,
    data,
    value: nativeIn ? amountIn : 0n,
    quotedAmountOut: input.quotedAmountOut,
    minAmountOut,
    tokenIn: nativeIn ? tokenIn : getAddress(tokenIn),
    tokenOut: isNativeAsset(tokenOut) ? tokenOut : getAddress(tokenOut),
    amountIn,
  };
}

/**
 * Fetch a Kyber route and its build calldata, then wrap one V3 leg.
 * The build `sender` and `recipient` are the Li.Fi diamond. `treasury`
 * is only the outer receiver.
 */
export async function buildKyberLifiSwap(
  request: KyberLifiSwapRequest,
  options: KyberLifiSwapOptions = {},
): Promise<KyberLifiSwap> {
  if (request.amountIn <= 0n) fail('amountIn must be greater than zero');
  const slug = chainSlug(request.chainId);
  const tokenIn = aggregatorToken(request.tokenIn);
  const tokenOut = aggregatorToken(request.tokenOut);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-client-id': 'evalanche',
  };
  const routeUrl = new URL(`${KYBER_AGGREGATOR_API}/${slug}/api/v1/routes`);
  routeUrl.searchParams.set('tokenIn', tokenIn);
  routeUrl.searchParams.set('tokenOut', tokenOut);
  routeUrl.searchParams.set('amountIn', request.amountIn.toString());
  const route = await readKyber(routeUrl.toString(), { method: 'GET', headers }, options.fetchImpl);
  if (!route.data?.routeSummary) fail('Kyber route response has no routeSummary');
  const bps = tokenClassBps(request.slippageCaps, tokenOut);
  const diamond = getAddress(LIFI_DIAMOND);
  const build = await readKyber(`${KYBER_AGGREGATOR_API}/${slug}/api/v1/route/build`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      routeSummary: route.data.routeSummary,
      sender: diamond,
      recipient: diamond,
      slippageTolerance: bps,
      source: 'evalanche',
    }),
  }, options.fetchImpl);
  const router = build.data?.routerAddress;
  if (!router || getAddress(router) !== getAddress(KYBER_META_AGGREGATION_ROUTER_V2)) {
    fail('Kyber build router is not MetaAggregationRouterV2');
  }
  const calldata = build.data?.data;
  if (!calldata || !calldata.startsWith('0x')) fail('Kyber build response has no calldata');
  let quotedAmountOut: bigint;
  try {
    quotedAmountOut = BigInt(build.data?.amountOut ?? '');
  } catch {
    fail('Kyber build response has no amountOut');
  }
  return assembleLifiV3FromKyber({
    chainId: request.chainId,
    calldata,
    quotedAmountOut,
    treasury: request.treasury,
    slippageCaps: request.slippageCaps,
  });
}
