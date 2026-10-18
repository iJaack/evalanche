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
  KYBER_SWAP_SELECTOR,
  LIFI_DIAMOND,
  LIFI_NATIVE_SENTINEL,
  SELECTOR,
  isNativeAsset,
} from '../signer/decode';
import { type SlippageCaps } from '../signer/server';
import { proposerSlippageBps } from './slippage';
import {
  KYBER_ROUTE_CHAIN_IDS,
  kyberRouteChain,
  type KyberRouteChain,
} from './kyber-chains';

export const KYBER_AGGREGATOR_API = 'https://aggregator-api.kyberswap.com';
export { KYBER_ROUTE_CHAIN_IDS, KYBER_ROUTE_CHAINS, kyberRouteChain } from './kyber-chains';
export type { KyberRouteChain } from './kyber-chains';

/** Build `amountOut` may differ from the route quote by at most this many bps. */
const ROUTE_BUILD_AMOUNT_TOLERANCE_BPS = 10n;

/** A quote more than this far under an independent reference is refused. */
const REFERENCE_MAX_DISCOUNT_BPS = 100n;

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
  /**
   * V3 receiver. Must equal `treasury`. Omitted means `treasury`.
   * A different address is refused.
   */
  recipient?: string;
  slippageCaps?: SlippageCaps;
}

/** The trade a reference-price fetcher is asked to price. */
export interface KyberReferenceRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
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
  /** Wrapped native on this chain. Native swaps still use the `0xeeee…` sentinel. */
  wrappedNative: string;
}

interface KyberRouteSummary {
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  amountOut?: string;
  routerAddress?: string;
  chainId?: number | string;
}

interface KyberBuildData {
  routeSummary?: KyberRouteSummary;
  routerAddress?: string;
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  tokenOut?: string;
  data?: string;
  chainId?: number | string;
}

interface KyberEnvelope {
  code?: number;
  message?: string;
  data?: KyberBuildData;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The signer config this route will be submitted to.
 * An omitted `lifiDiamond` is the signer's canonical default. It must equal
 * the builder pin. HyperEVM, Robinhood, Linea, and Berachain disagree with
 * that default, so those chains are refused until the pinned diamond is set.
 * `router` and `wrappedNative`, when set, must equal the pins.
 */
export interface KyberSignerPins {
  lifiDiamond?: string;
  router?: string;
  wrappedNative?: string;
  /**
   * Slippage caps from the signer chain config. Required off Avalanche.
   * The builder uses these as the ceiling so minOut is not looser than the
   * signer's per-class cap.
   */
  slippageCaps?: SlippageCaps;
}

export interface KyberLifiSwapOptions {
  /** Test double. Production uses {@link safeFetch}. */
  fetchImpl?: FetchLike;
  /**
   * Signer diamond, router, and wrapped native. The builder refuses when
   * these disagree with its pins. An omitted diamond is the canonical Li.Fi
   * diamond the signer uses when `lifiDiamond` is unset.
   */
  signer?: KyberSignerPins;
  /**
   * Independent bought-token amount, or a fetcher that returns one
   * (a second Kyber route, CoinGecko, or another source). The builder
   * refuses when `quotedAmountOut` is more than 1% below it. Omitted
   * means the check is off. The signer never calls this.
   */
  referencePrice?: bigint | ((request: KyberReferenceRequest) => Promise<bigint> | bigint);
  /**
   * Chain ids the treasury signer has enabled. A pinned Kyber chain that is
   * not in this list is refused. Omitted means every pinned Kyber chain.
   */
  enabledChainIds?: readonly number[];
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_PARAMS);
}

function chainRoute(chainId: number, enabledChainIds?: readonly number[]): KyberRouteChain {
  const route = kyberRouteChain(chainId);
  if (!route) fail(`Kyber route builder does not support chain ${chainId}`);
  const enabled = enabledChainIds ?? KYBER_ROUTE_CHAIN_IDS;
  if (!enabled.includes(chainId)) fail(`Kyber route builder refuses disabled chain ${chainId}`);
  return route;
}

function readSignerAddress(value: string, label: string): string {
  try {
    return getAddress(value);
  } catch {
    fail(`${label} is not an address`);
  }
}

/**
 * The signer defaults an omitted diamond to the canonical Li.Fi diamond.
 * A chain whose pin is a different diamond fails closed until config sets it.
 * Router and wrapped native are checked only when the signer config sets them.
 */
function assertSignerPins(pinned: KyberRouteChain, signer?: KyberSignerPins): void {
  const diamond = readSignerAddress(signer?.lifiDiamond ?? LIFI_DIAMOND, 'signer lifiDiamond');
  if (diamond !== getAddress(pinned.diamond)) {
    fail(`Kyber Li.Fi diamond does not match the signer config for chain ${pinned.chainId}`);
  }
  if (signer?.router !== undefined) {
    const router = readSignerAddress(signer.router, 'signer router');
    if (router !== getAddress(pinned.router)) {
      fail(`Kyber router does not match the signer config for chain ${pinned.chainId}`);
    }
  }
  if (signer?.wrappedNative !== undefined) {
    const wrapped = readSignerAddress(signer.wrappedNative, 'signer wrappedNative');
    if (wrapped !== getAddress(pinned.wrappedNative)) {
      fail(`Kyber wrapped native does not match the signer config for chain ${pinned.chainId}`);
    }
  }
}

function treasuryAddress(value: string): string {
  try {
    return getAddress(value);
  } catch {
    fail('treasury is not an address');
  }
}

/** The V3 receiver is the treasury. Any other recipient is refused. */
function assertRecipientIsTreasury(recipient: string | undefined, treasury: string): void {
  if (recipient === undefined) return;
  let decoded: string;
  try {
    decoded = getAddress(recipient);
  } catch {
    fail('recipient is not the treasury');
  }
  if (decoded !== treasury) fail('recipient is not the treasury');
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

function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  if (isNativeAsset(left) && isNativeAsset(right)) return true;
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function parseUnits(value: string | undefined, label: string): bigint {
  if (value === undefined || value === '' || !/^\d+$/.test(value)) fail(`${label} is missing`);
  return BigInt(value);
}

function chainRouter(chainId: number, enabledChainIds?: readonly number[]): string {
  return getAddress(chainRoute(chainId, enabledChainIds).router);
}

function assertChainId(reported: number | string | undefined, chainId: number, label: string): void {
  if (reported === undefined || reported === '') return;
  if (String(reported) !== String(chainId)) fail(`${label} chain does not match the request`);
}

function assertRouter(reported: string | undefined, expected: string, label: string): void {
  if (!reported) fail(`${label} router is missing`);
  let router: string;
  try {
    router = getAddress(reported);
  } catch {
    fail(`${label} router is not an address`);
  }
  if (router !== expected) fail(`${label} router is not the router for this chain`);
}

interface DecodedKyberSwap {
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  feeAmounts: readonly bigint[];
}

function readKyberSwap(calldata: string): DecodedKyberSwap {
  if (calldata.slice(0, 10).toLowerCase() !== KYBER_SWAP_SELECTOR) {
    fail('Kyber router selector is not swap');
  }
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = KYBER.decodeFunctionData('swap', calldata);
  } catch {
    fail('Kyber swap calldata could not be decoded');
  }
  const execution = decoded[0];
  const again = KYBER.encodeFunctionData('swap', [execution]);
  if (again.toLowerCase() !== calldata.toLowerCase()) {
    fail('Kyber swap calldata has trailing bytes');
  }
  const desc = execution.desc as DecodedKyberSwap;
  return {
    srcToken: String(desc.srcToken),
    dstToken: String(desc.dstToken),
    dstReceiver: String(desc.dstReceiver),
    amount: BigInt(desc.amount),
    feeAmounts: desc.feeAmounts,
  };
}

/**
 * The route summary and the build must be the trade that was requested.
 * `tokenIn`, `tokenOut`, and `amountIn` are exact. The router must be the
 * one for `chainId`. Build `amountOut` may differ from the route quote by
 * at most 0.1%.
 */
function assertKyberResponsesMatchRequest(
  request: KyberLifiSwapRequest,
  tokenIn: string,
  tokenOut: string,
  route: KyberEnvelope,
  build: KyberEnvelope,
  calldata: string,
  enabledChainIds?: readonly number[],
): bigint {
  const summary = route.data?.routeSummary;
  if (!summary) fail('Kyber route response has no routeSummary');
  const router = chainRouter(request.chainId, enabledChainIds);
  assertChainId(summary.chainId, request.chainId, 'Kyber route');
  assertChainId(build.data?.chainId, request.chainId, 'Kyber build');
  if (!sameToken(summary.tokenIn, tokenIn)) fail('Kyber route tokenIn does not match the request');
  if (!sameToken(summary.tokenOut, tokenOut)) fail('Kyber route tokenOut does not match the request');
  if (parseUnits(summary.amountIn, 'Kyber route amountIn') !== request.amountIn) {
    fail('Kyber route amountIn does not match the request');
  }
  assertRouter(summary.routerAddress ?? route.data?.routerAddress, router, 'Kyber route');
  if (route.data?.routerAddress) assertRouter(route.data.routerAddress, router, 'Kyber route');
  if (summary.routerAddress && route.data?.routerAddress && getAddress(summary.routerAddress) !== getAddress(route.data.routerAddress)) {
    fail('Kyber route router does not match the route summary');
  }

  if (parseUnits(build.data?.amountIn, 'Kyber build amountIn') !== request.amountIn) {
    fail('Kyber build amountIn does not match the request');
  }
  if (build.data?.tokenIn && !sameToken(build.data.tokenIn, tokenIn)) {
    fail('Kyber build tokenIn does not match the request');
  }
  if (build.data?.tokenOut && !sameToken(build.data.tokenOut, tokenOut)) {
    fail('Kyber build tokenOut does not match the request');
  }
  assertRouter(build.data?.routerAddress, router, 'Kyber build');

  const swap = readKyberSwap(calldata);
  if (!sameToken(swap.srcToken, tokenIn)) fail('Kyber build tokenIn does not match the request');
  if (!sameToken(swap.dstToken, tokenOut)) fail('Kyber build tokenOut does not match the request');
  if (swap.amount !== request.amountIn) fail('Kyber build amountIn does not match the request');

  const routeOut = parseUnits(summary.amountOut, 'Kyber route amountOut');
  const buildOut = parseUnits(build.data?.amountOut, 'Kyber build amountOut');
  if (routeOut <= 0n || buildOut <= 0n) fail('Kyber amountOut must be greater than zero');
  const diff = routeOut > buildOut ? routeOut - buildOut : buildOut - routeOut;
  if (diff * 10_000n > routeOut * ROUTE_BUILD_AMOUNT_TOLERANCE_BPS) {
    fail('Kyber build amountOut does not match the route amountOut');
  }
  return buildOut;
}

/**
 * Proposer-side only. A missing reference skips the check. A quote above
 * the reference, or as little as 1% under it, is kept.
 */
async function assertQuotedNearReference(
  quoted: bigint,
  request: KyberReferenceRequest,
  reference: KyberLifiSwapOptions['referencePrice'],
): Promise<void> {
  if (reference === undefined) return;
  const value = typeof reference === 'function' ? await reference(request) : reference;
  if (typeof value !== 'bigint' || value <= 0n) fail('Kyber reference price must be a positive amount');
  if (quoted * 10_000n < value * (10_000n - REFERENCE_MAX_DISCOUNT_BPS)) {
    fail('Kyber quotedAmountOut is more than 1% below the reference price');
  }
}

function classFloor(
  quoted: bigint,
  tokenOut: string,
  chainId: number,
  caps: SlippageCaps | undefined,
  signerCaps: SlippageCaps | undefined,
): bigint {
  if (quoted <= 0n) fail('Kyber amountOut must be greater than zero');
  const bps = proposerSlippageBps({
    chainId,
    tokenOut,
    slippageCaps: caps,
    signerSlippageCaps: signerCaps,
  });
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
  recipient?: string;
  slippageCaps?: SlippageCaps;
  enabledChainIds?: readonly number[];
  signer?: KyberSignerPins;
}): KyberLifiSwap {
  const chainId = input.chainId;
  const pinned = chainRoute(chainId, input.enabledChainIds);
  assertSignerPins(pinned, input.signer);
  const treasury = treasuryAddress(input.treasury);
  assertRecipientIsTreasury(input.recipient, treasury);
  const desc = readKyberSwap(input.calldata);
  const diamond = getAddress(pinned.diamond);
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
  const minAmountOut = classFloor(
    input.quotedAmountOut,
    isNativeAsset(tokenOut) ? tokenOut : getAddress(tokenOut),
    chainId,
    input.slippageCaps,
    input.signer?.slippageCaps,
  );
  const router = getAddress(pinned.router);
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
    wrappedNative: getAddress(pinned.wrappedNative),
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
  const pinned = chainRoute(request.chainId, options.enabledChainIds);
  assertSignerPins(pinned, options.signer);
  const treasury = treasuryAddress(request.treasury);
  assertRecipientIsTreasury(request.recipient, treasury);
  const slug = pinned.slug;
  const tokenIn = aggregatorToken(request.tokenIn);
  const tokenOut = aggregatorToken(request.tokenOut);
  const bps = proposerSlippageBps({
    chainId: request.chainId,
    tokenOut,
    slippageCaps: request.slippageCaps,
    signerSlippageCaps: options.signer?.slippageCaps,
  });
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
  const diamond = getAddress(pinned.diamond);
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
  const calldata = build.data?.data;
  if (!calldata || !calldata.startsWith('0x')) fail('Kyber build response has no calldata');
  const quotedAmountOut = assertKyberResponsesMatchRequest(
    request,
    tokenIn,
    tokenOut,
    route,
    build,
    calldata,
    options.enabledChainIds,
  );
  await assertQuotedNearReference(quotedAmountOut, {
    chainId: request.chainId,
    tokenIn,
    tokenOut,
    amountIn: request.amountIn,
  }, options.referencePrice);
  return assembleLifiV3FromKyber({
    chainId: request.chainId,
    calldata,
    quotedAmountOut,
    treasury,
    recipient: request.recipient,
    slippageCaps: request.slippageCaps,
    enabledChainIds: options.enabledChainIds,
    signer: options.signer,
  });
}
