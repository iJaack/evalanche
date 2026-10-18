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

import { Interface, getAddress, solidityPacked } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { isNativeAsset } from '../signer/decode';
import {
  DEX_MAX_DEADLINE_SEC,
  decodeDexCalldata,
  dexVenue,
  type DexPoolConfig,
  type DexVenueConfig,
  type PinnedDexVenue,
} from '../signer/dex-venue';
import { tokenClassBps, type SlippageCaps } from '../signer/server';

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
]);

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
  caps: SlippageCaps | undefined,
  maxSlippageBps: number | undefined,
  minAmountOut: bigint | undefined,
  tokenOutCap: bigint | undefined,
): bigint {
  if (typeof quoted !== 'bigint' || quoted <= 0n) {
    if (quoted === undefined) fail('quotedAmountOut is required for a direct DEX swap');
    fail('quotedAmountOut must be greater than zero');
  }
  const classBps = tokenClassBps(caps, tokenOut, false);
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
  const tokenIn = address(request.tokenIn, 'DEX tokenIn');
  const tokenOut = address(request.tokenOut, 'DEX tokenOut');
  if (isNativeAsset(tokenIn) || isNativeAsset(tokenOut)) fail('DEX transaction value must be 0');
  const tokens = [tokenIn];
  if (request.tokenMid !== undefined) tokens.push(address(request.tokenMid, 'DEX path token'));
  tokens.push(tokenOut);
  if (tokens.length < 2 || tokens.length > 3) fail('DEX path must contain 2 or 3 tokens');
  if (new Set(tokens).size !== tokens.length) fail('DEX path token pair must be two different addresses');

  const minAmountOut = classFloor(
    request.quotedAmountOut,
    tokenOut,
    request.slippageCaps,
    request.maxSlippageBps,
    request.minAmountOut,
    request.tokenOutCap,
  );
  const nowSec = request.nowSec ?? Math.floor(Date.now() / 1000);
  const deadline = resolveDeadline(request.deadline, nowSec);
  const pools = readPools(dex, venue);
  const v2 = venue.style === 'uniswap-v2';
  const hopCount = tokens.length - 1;
  let requestedFees: Array<number | undefined>;
  if (request.hopFees !== undefined) {
    if (request.hopFees.length !== hopCount) fail('DEX pool fee is ambiguous');
    requestedFees = [...request.hopFees];
  } else {
    requestedFees = Array.from({ length: hopCount }, () => request.fee);
  }
  const fees: number[] = [];
  for (let i = 0; i < hopCount; i += 1) {
    const fee = feeForHop(pools, tokens[i], tokens[i + 1], requestedFees[i], v2);
    if (fee !== undefined) fees.push(fee);
  }
  if (!v2 && fees.length !== hopCount) fail('DEX pool is not allowlisted');

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
