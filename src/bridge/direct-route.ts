/**
 * Proposer-side direct router intents.
 *
 * Cronos VVS encodes `swapExactTokensForTokens` only. Gnosis and Celo wrap
 * one `exactInputSingle` or packed `exactInput` in `multicall(uint256,bytes[])`.
 * Mantle Agni encodes SwapRouter `exactInputSingle` or `exactInput`, and only
 * after `poolDepthVerified` and a `verifiedAt` date the signer will boot with.
 *
 * The builder never sends native value, never sets `sqrtPriceLimitX96`, and
 * re-decodes the bytes with the signer decoder so a trailing byte, a missed
 * hop, or a deadline outside the next 600 seconds fails closed here.
 */

import { Interface, MaxUint256, getAddress, solidityPacked } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { decodeCalldata, isNativeAsset } from '../signer/decode';
import {
  DEX_MAX_DEADLINE_SEC,
  decodeDexCalldata,
  dexVenue,
  type DexPoolConfig,
  type DexVenueConfig,
  type PinnedDexVenue,
} from '../signer/dex-venue';
import { type SlippageCaps } from '../signer/server';
import { proposerSlippageBps } from './slippage';

const SWAP_ROUTER_02 = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

const SWAP_ROUTER = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
]);

const V2 = new Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

const QUOTER_V2 = new Interface([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/**
 * QuoterV2 on Gnosis. Official Uniswap v3 deployment list
 * (https://gov.uniswap.org/t/official-uniswap-v3-deployments-list/24323),
 * same factory as the pinned SwapRouter02. On 18 October 2026 `factory()`
 * returned `0xe32F7dD7e3f098D518ff19A22d5f028e076489B1` and the code was 8273
 * bytes with `quoteExactInput` (`0xcdca1753`).
 */
export const GNOSIS_QUOTER_V2 = '0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4';

/**
 * QuoterV2 on Celo. Uniswap docs
 * (https://developers.uniswap.org/docs/protocols/v3/deployments/v3-celo-deployments)
 * and https://docs.celo.org/build/tools/contracts/uniswap-contracts.
 * On 18 October 2026 `factory()` returned `0xAfE208a311B21f13EF87E33A90049fC17A7acDEc`
 * and the code was 8273 bytes with `quoteExactInput`.
 */
export const CELO_QUOTER_V2 = '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8';

interface NormalizedPool {
  tokenA: string;
  tokenB: string;
  fee?: number;
}

export interface DirectDexSwapRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  /** Middle token. Omitted is one hop. */
  tokenMid?: string;
  amountIn: bigint;
  /** Recipient. The signer requires this to be the treasury wallet. */
  treasury: string;
  /** Bought-token quote. Required. minOut is this quote after class slippage. */
  quotedAmountOut: bigint;
  /** Signer `dex` config, including `pools`. The venue must be enabled. */
  dex: DexVenueConfig;
  slippageCaps?: SlippageCaps;
  /**
   * Signer chain slippage caps. Off Avalanche, these or `slippageCaps` are
   * required. When both are set, the signer caps are the ceiling.
   */
  signer?: { slippageCaps?: SlippageCaps };
  /**
   * Encoded minOut. Omitted uses the class floor. A value under that floor
   * is refused. A higher value is kept.
   */
  minAmountOut?: bigint;
  /** Must be within the bought-token class cap. Tightens the floor when lower. */
  maxSlippageBps?: number;
  /** Bought-token cap. A quote above it is refused. */
  tokenOutCap?: bigint;
  /** Unix seconds. Omitted is 120 seconds ahead of `nowSec`, inside the 600 second window. */
  deadline?: bigint;
  /** Clock for the deadline check. Omitted is the current unix second. */
  nowSec?: number;
  /** Must be 0 when set. The encoded transaction value is always 0. */
  value?: bigint;
  /** Must be 0 when set. The encoded limit is always 0. */
  sqrtPriceLimitX96?: bigint;
  /**
   * Ask for an outer multicall. Cronos and Mantle refuse. Gnosis and Celo
   * already use a timed multicall, so `false` is refused there.
   */
  multicall?: boolean;
  /** Fee tier for every hop. Omitted uses the one allowlisted fee for that pair. */
  fee?: number;
  /** One fee per hop. When set, `fee` is not used. */
  hopFees?: readonly number[];
}

export interface DirectDexSwap {
  chainId: number;
  /** Pinned router. */
  to: string;
  data: string;
  value: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  deadline: bigint;
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_PARAMS);
}

function address(value: string, label: string): string {
  try {
    return getAddress(value);
  } catch {
    fail(`${label} is not an address`);
  }
}

function assertMantleDepth(config: DexVenueConfig): void {
  if (config.poolDepthVerified !== true) fail('Mantle pool depth must be rechecked first');
  if (!isOnOrBeforeToday(config.verifiedAt)) {
    fail('Mantle pool depth must be rechecked first; verifiedAt must be a YYYY-MM-DD date on or before today');
  }
}

function isOnOrBeforeToday(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return date.getTime() <= today;
}

function readPools(config: DexVenueConfig, venue: PinnedDexVenue): NormalizedPool[] {
  const reject: (message: string) => never = (message) => fail(message);
  const prefix = 'DEX pool allowlist';
  const raw = config.pools;
  if (!Array.isArray(raw) || raw.length === 0) reject('DEX pool allowlist is empty');
  const v2 = venue.style === 'uniswap-v2';
  const out: NormalizedPool[] = [];
  const seen = new Set<string>();
  for (const entry of raw as DexPoolConfig[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      reject(`${prefix} must be a list of pool objects`);
    }
    const tokenA = address(String(entry.tokenA), `${prefix} tokenA`);
    const tokenB = address(String(entry.tokenB), `${prefix} tokenB`);
    if (tokenA === tokenB) reject(`${prefix} token pair must be two different addresses`);
    let fee: number | undefined;
    if (entry.fee !== undefined) {
      if (v2) reject(`${prefix} must not set a fee on a v2 pool`);
      if (!Number.isInteger(entry.fee) || entry.fee <= 0 || entry.fee > 1_000_000) {
        reject(`${prefix} fee must be a positive integer up to 1000000`);
      }
      fee = entry.fee;
    } else if (!v2) {
      reject(`${prefix} requires a fee tier on a v3 pool`);
    }
    const key = poolKey(tokenA, tokenB, fee);
    if (seen.has(key)) reject(`${prefix} lists the same pool twice`);
    seen.add(key);
    out.push({ tokenA, tokenB, fee });
  }
  return out;
}

function poolKey(tokenA: string, tokenB: string, fee: number | undefined): string {
  const [a, b] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return `${a}|${b}|${fee ?? ''}`;
}

function samePair(left: NormalizedPool, tokenA: string, tokenB: string): boolean {
  return (left.tokenA === tokenA && left.tokenB === tokenB)
    || (left.tokenA === tokenB && left.tokenB === tokenA);
}

function feeForHop(pools: NormalizedPool[], tokenA: string, tokenB: string, requested: number | undefined, v2: boolean): number | undefined {
  const matches = pools.filter((pool) => samePair(pool, tokenA, tokenB));
  if (matches.length === 0) fail('DEX pool is not allowlisted');
  if (v2) {
    if (requested !== undefined) fail('DEX pool allowlist must not set a fee on a v2 pool');
    return undefined;
  }
  if (requested !== undefined) {
    if (!matches.some((pool) => pool.fee === requested)) fail('DEX pool is not allowlisted');
    return requested;
  }
  const fees = [...new Set(matches.map((pool) => pool.fee))];
  if (fees.length !== 1 || fees[0] === undefined) fail('DEX pool fee is ambiguous');
  return fees[0];
}

function classFloor(
  quoted: bigint,
  tokenOut: string,
  chainId: number,
  caps: SlippageCaps | undefined,
  signerCaps: SlippageCaps | undefined,
  maxSlippageBps: number | undefined,
  minAmountOut: bigint | undefined,
  tokenOutCap: bigint | undefined,
): bigint {
  if (typeof quoted !== 'bigint' || quoted <= 0n) {
    if (quoted === undefined) fail('quotedAmountOut is required for a direct DEX swap');
    fail('quotedAmountOut must be greater than zero');
  }
  const classBps = proposerSlippageBps({
    chainId,
    tokenOut,
    slippageCaps: caps,
    signerSlippageCaps: signerCaps,
  });
  if (maxSlippageBps !== undefined) {
    if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 10_000) {
      fail('maxSlippageBps must be an integer from 0 to 10000');
    }
    if (maxSlippageBps > classBps) {
      fail(`maxSlippageBps exceeds the ${classBps} bps token class slippage cap`);
    }
  }
  if (tokenOutCap !== undefined && quoted > tokenOutCap) {
    fail('quotedAmountOut exceeds the configured token cap');
  }
  const bps = maxSlippageBps ?? classBps;
  const floor = quoted * (10_000n - BigInt(bps)) / 10_000n;
  if (floor <= 0n) fail('quotedAmountOut is too small to leave a positive token-unit slippage floor');
  if (minAmountOut === undefined) return floor;
  if (typeof minAmountOut !== 'bigint' || minAmountOut < floor) {
    fail('decoded minOut is below the quoted slippage floor');
  }
  return minAmountOut;
}

function resolveDeadline(requested: bigint | undefined, nowSec: number): bigint {
  const now = BigInt(nowSec);
  const deadline = requested ?? now + 120n;
  if (typeof deadline !== 'bigint') fail('DEX deadline is not in the future');
  if (deadline <= now) fail('DEX deadline is not in the future');
  if (deadline > now + BigInt(DEX_MAX_DEADLINE_SEC)) fail('DEX deadline is more than 10 minutes ahead');
  return deadline;
}

function packPath(tokens: string[], fees: number[]): string {
  const types: string[] = [];
  const values: Array<string | number> = [];
  tokens.forEach((token, index) => {
    types.push('address');
    values.push(token);
    if (index < fees.length) {
      types.push('uint24');
      values.push(fees[index]);
    }
  });
  return solidityPacked(types, values);
}

function pathTokens(tokenIn: string, tokenOut: string, tokenMid: string | undefined): string[] {
  const tokens = [address(tokenIn, 'DEX tokenIn')];
  if (tokenMid !== undefined) tokens.push(address(tokenMid, 'DEX path token'));
  tokens.push(address(tokenOut, 'DEX tokenOut'));
  if (tokens.length < 2 || tokens.length > 3) fail('DEX path must contain 2 or 3 tokens');
  if (new Set(tokens).size !== tokens.length) fail('DEX path token pair must be two different addresses');
  if (isNativeAsset(tokens[0]) || isNativeAsset(tokens[tokens.length - 1])) fail('DEX transaction value must be 0');
  return tokens;
}

function allowlistedFees(
  venue: PinnedDexVenue,
  dex: DexVenueConfig,
  tokens: string[],
  fee: number | undefined,
  hopFees: readonly number[] | undefined,
): number[] {
  const pools = readPools(dex, venue);
  const v2 = venue.style === 'uniswap-v2';
  const hopCount = tokens.length - 1;
  const requestedFees = hopFees !== undefined ? [...hopFees] : Array.from({ length: hopCount }, () => fee);
  if (requestedFees.length !== hopCount) fail('DEX pool fee is ambiguous');
  const fees: number[] = [];
  for (let i = 0; i < hopCount; i += 1) {
    const hopFee = feeForHop(pools, tokens[i], tokens[i + 1], requestedFees[i], v2);
    if (hopFee !== undefined) fees.push(hopFee);
  }
  if (!v2 && fees.length !== hopCount) fail('DEX pool is not allowlisted');
  return fees;
}

function encodeSwap(
  venue: PinnedDexVenue,
  tokens: string[],
  fees: number[],
  amountIn: bigint,
  minOut: bigint,
  treasury: string,
  deadline: bigint,
): string {
  const tokenIn = tokens[0];
  const tokenOut = tokens[tokens.length - 1];
  if (venue.style === 'uniswap-v2') {
    return V2.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, tokens, treasury, deadline]);
  }
  if (venue.style === 'swap-router') {
    if (tokens.length === 2) {
      return SWAP_ROUTER.encodeFunctionData('exactInputSingle', [{
        tokenIn,
        tokenOut,
        fee: fees[0],
        recipient: treasury,
        deadline,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      }]);
    }
    return SWAP_ROUTER.encodeFunctionData('exactInput', [{
      path: packPath(tokens, fees),
      recipient: treasury,
      deadline,
      amountIn,
      amountOutMinimum: minOut,
    }]);
  }
  const inner = tokens.length === 2
    ? SWAP_ROUTER_02.encodeFunctionData('exactInputSingle', [{
      tokenIn,
      tokenOut,
      fee: fees[0],
      recipient: treasury,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }])
    : SWAP_ROUTER_02.encodeFunctionData('exactInput', [{
      path: packPath(tokens, fees),
      recipient: treasury,
      amountIn,
      amountOutMinimum: minOut,
    }]);
  return SWAP_ROUTER_02.encodeFunctionData('multicall(uint256,bytes[])', [deadline, [inner]]);
}

/**
 * Build one direct-router swap the signer decoder accepts.
 * Sonic and HyperEVM are not direct venues and are refused.
 */
export function buildDirectDexSwap(request: DirectDexSwapRequest): DirectDexSwap {
  const venue = dexVenue(request.chainId);
  if (!venue) fail(`direct route builder does not support chain ${request.chainId}`);
  const dex = request.dex;
  if (!dex || dex.enabled !== true) fail('DEX venue is disabled');
  if (venue.chainId === 5000) assertMantleDepth(dex);
  if (dex.router !== undefined && address(dex.router, 'DEX router') !== venue.router) {
    fail('DEX router does not match the pinned router');
  }
  if (dex.wrappedNative !== undefined && address(dex.wrappedNative, 'DEX wrapped native') !== venue.wrappedNative) {
    fail('DEX wrapped native does not match the pinned wrapped native');
  }
  if (request.value !== undefined && request.value !== 0n) fail('DEX transaction value must be 0');
  if (request.sqrtPriceLimitX96 !== undefined && request.sqrtPriceLimitX96 !== 0n) {
    fail('DEX sqrtPriceLimitX96 must be 0');
  }
  if (request.amountIn <= 0n) fail('DEX amountIn must be greater than zero');
  if (request.multicall === true && venue.style !== 'swap-router02') {
    fail(venue.style === 'uniswap-v2'
      ? 'Cronos VVS does not accept multicall'
      : 'Mantle Agni intent does not use multicall');
  }
  if (request.multicall === false && venue.style === 'swap-router02') {
    fail('DEX selector is denied without a timed multicall');
  }

  const treasury = address(request.treasury, 'DEX treasury');
  const tokens = pathTokens(request.tokenIn, request.tokenOut, request.tokenMid);
  const tokenIn = tokens[0];
  const tokenOut = tokens[tokens.length - 1];

  const minAmountOut = classFloor(
    request.quotedAmountOut,
    tokenOut,
    venue.chainId,
    request.slippageCaps,
    request.signer?.slippageCaps,
    request.maxSlippageBps,
    request.minAmountOut,
    request.tokenOutCap,
  );
  const nowSec = request.nowSec ?? Math.floor(Date.now() / 1000);
  const deadline = resolveDeadline(request.deadline, nowSec);
  const fees = allowlistedFees(venue, dex, tokens, request.fee, request.hopFees);
  const v2 = venue.style === 'uniswap-v2';

  const data = encodeSwap(venue, tokens, fees, request.amountIn, minAmountOut, treasury, deadline);
  const decoded = decodeDexCalldata(venue.router, data, {
    chainId: venue.chainId,
    config: dex,
    wallet: treasury,
    value: 0n,
    tokenIn,
    tokenOut,
    amountIn: request.amountIn,
    allowRole: (token) => {
      try {
        return tokens.includes(getAddress(token));
      } catch {
        return false;
      }
    },
    nowSec,
  });
  if (decoded.length !== 1) fail('DEX path must contain 2 or 3 tokens');
  const swap = decoded[0];
  if (swap.tokenIn !== tokenIn || swap.tokenOut !== tokenOut) fail('DEX path tokenIn does not match the intent');
  if (swap.amountIn !== request.amountIn) fail('DEX amountIn does not match the intent');
  if (swap.minOut !== minAmountOut) fail('decoded minOut is below the quoted slippage floor');
  if (swap.recipient !== treasury) fail('DEX recipient is not the treasury');
  if (data.slice(0, 10).toLowerCase() === '0xac9650d8' || (v2 && data.slice(0, 10).toLowerCase() === '0x5ae401dc')) {
    fail('Cronos VVS does not accept multicall');
  }

  return {
    chainId: venue.chainId,
    to: venue.router,
    data,
    value: 0n,
    quotedAmountOut: request.quotedAmountOut,
    minAmountOut,
    tokenIn,
    tokenOut,
    amountIn: request.amountIn,
    deadline,
  };
}

export interface DirectQuoteRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  tokenMid?: string;
  amountIn: bigint;
  /** Pools the quote is allowed to use. The same list `buildDirectDexSwap` reads. */
  dex: DexVenueConfig;
  fee?: number;
  hopFees?: readonly number[];
  /** Test double. Production passes `rpcUrl` or this caller. */
  callImpl?: (to: string, data: string) => Promise<string>;
  /** HTTPS JSON-RPC. Used when `callImpl` is omitted. */
  rpcUrl?: string;
}

export interface DirectQuote {
  chainId: number;
  to: string;
  data: string;
  quotedAmountOut: bigint;
}

function quoterFor(chainId: number): { to: string; style: 'v2' | 'v3' } {
  if (chainId === 25) {
    const venue = dexVenue(25);
    if (!venue) fail('direct quote helper does not support chain 25');
    return { to: venue.router, style: 'v2' };
  }
  if (chainId === 100) return { to: getAddress(GNOSIS_QUOTER_V2), style: 'v3' };
  if (chainId === 42220) return { to: getAddress(CELO_QUOTER_V2), style: 'v3' };
  fail(`direct quote helper does not support chain ${chainId}`);
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  if (!rpcUrl.startsWith('https://')) fail('direct quote RPC must be https');
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
  } catch (error) {
    throw new EvalancheError(
      'direct quote RPC request failed',
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
  if (!response.ok) {
    throw new EvalancheError(`direct quote RPC HTTP ${response.status}`, EvalancheErrorCode.NETWORK_ERROR);
  }
  let body: { result?: string; error?: { message?: string } };
  try {
    body = await response.json() as { result?: string; error?: { message?: string } };
  } catch (error) {
    throw new EvalancheError(
      'direct quote RPC returned malformed JSON',
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
  if (!body.result || !body.result.startsWith('0x')) {
    throw new EvalancheError(
      `direct quote RPC rejected the call: ${body.error?.message ?? 'empty result'}`,
      EvalancheErrorCode.NETWORK_ERROR,
    );
  }
  return body.result;
}

/**
 * Quote a direct-router path. Cronos calls `getAmountsOut` on the pinned VVS
 * router. Gnosis and Celo call `quoteExactInput` on the pinned QuoterV2.
 * Mantle is not quoted. The hops must already be in `dex.pools`.
 */
export async function quoteDirectDexSwap(request: DirectQuoteRequest): Promise<DirectQuote> {
  const venue = dexVenue(request.chainId);
  if (!venue) fail(`direct quote helper does not support chain ${request.chainId}`);
  if (request.amountIn <= 0n) fail('DEX amountIn must be greater than zero');
  const quoter = quoterFor(request.chainId);
  const tokens = pathTokens(request.tokenIn, request.tokenOut, request.tokenMid);
  const fees = allowlistedFees(venue, request.dex, tokens, request.fee, request.hopFees);
  const data = quoter.style === 'v2'
    ? V2.encodeFunctionData('getAmountsOut', [request.amountIn, tokens])
    : QUOTER_V2.encodeFunctionData('quoteExactInput', [packPath(tokens, fees), request.amountIn]);
  const call = request.callImpl ?? (request.rpcUrl ? (to: string, encoded: string) => ethCall(request.rpcUrl as string, to, encoded) : undefined);
  if (!call) fail('direct quote needs an eth_call');
  let raw: string;
  try {
    raw = await call(quoter.to, data);
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    throw new EvalancheError(
      'direct quote could not be decoded',
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
  let quotedAmountOut: bigint;
  try {
    if (quoter.style === 'v2') {
      const decoded = V2.decodeFunctionResult('getAmountsOut', raw);
      const amounts = decoded[0] as bigint[];
      quotedAmountOut = BigInt(amounts[amounts.length - 1]);
    } else {
      const decoded = QUOTER_V2.decodeFunctionResult('quoteExactInput', raw);
      quotedAmountOut = BigInt(decoded[0]);
    }
  } catch {
    fail('direct quote could not be decoded');
  }
  if (quotedAmountOut <= 0n) fail('quotedAmountOut must be greater than zero');
  return { chainId: venue.chainId, to: quoter.to, data, quotedAmountOut };
}

export interface ExactRouterApproval {
  chainId: number;
  /** Token contract. */
  to: string;
  data: string;
  value: bigint;
  spender: string;
  amount: bigint;
}

/**
 * `approve` of exactly `amountIn` to the pinned router. Unlimited approvals
 * are refused. The signer accepts this when the token has the token role,
 * the router has the spender role, and the intent amountIn matches.
 */
export function buildExactRouterApproval(input: {
  chainId: number;
  token: string;
  amountIn: bigint;
}): ExactRouterApproval {
  const venue = dexVenue(input.chainId);
  if (!venue) fail(`direct route builder does not support chain ${input.chainId}`);
  if (typeof input.amountIn !== 'bigint' || input.amountIn <= 0n) fail('DEX amountIn must be greater than zero');
  if (input.amountIn === MaxUint256) fail('Unlimited ERC-20 approval is denied');
  const token = address(input.token, 'DEX tokenIn');
  const data = ERC20.encodeFunctionData('approve', [venue.router, input.amountIn]);
  const decoded = decodeCalldata(token, data, {
    wallet: '0x0000000000000000000000000000000000000001',
    value: 0n,
    explicitAllows: new Set(),
    tokenIn: token,
    amountIn: input.amountIn,
    allowAddress: () => true,
    allowSelector: (to, selector) => {
      try {
        return getAddress(to) === token && selector.toLowerCase() === '0x095ea7b3';
      } catch {
        return false;
      }
    },
    allowRole: (spender, role) => {
      try {
        const who = getAddress(spender);
        if (role === 'spender') return who === venue.router;
        if (role === 'token') return who === token;
      } catch {
        return false;
      }
      return false;
    },
  });
  if (decoded.length !== 1 || decoded[0]?.kind !== 'erc20-approve' || decoded[0].amount !== input.amountIn) {
    fail('decoded approval amount does not equal amountIn');
  }
  if (getAddress(String(decoded[0].spender)) !== venue.router) fail('approve spender is not the pinned router');
  return {
    chainId: venue.chainId,
    to: token,
    data,
    value: 0n,
    spender: venue.router,
    amount: input.amountIn,
  };
}
