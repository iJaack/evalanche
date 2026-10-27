/**
 * Pinned direct swap venues for chains the Kyber plus Li.Fi path cannot serve.
 *
 * A venue is one immutable router. The signer allows only the selectors below,
 * requires every path token to carry the token role, requires the recipient
 * to be the treasury, requires a nonzero amountOutMin, and caps the deadline
 * at ten minutes. Multicall is signed only when every inner call passes those
 * same checks. Nested multicall is denied. Every hop must match dex.pools.
 * Chains with no such router stay out of this map and cannot be enabled.
 *
 * Addresses were read from the public RPCs named in docs/signer-multichain.md
 * on 18 October 2026. The venue stays off until chains[id].dex.enabled is true,
 * and the chain itself stays off until enabled is true.
 */

import { Interface, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const DEX_MAX_DEADLINE_SEC = 600;

const SWAP_ROUTER_02 = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);

const SWAP_ROUTER = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

const V2 = new Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

const SEL_EXACT_INPUT_SINGLE_02 = SWAP_ROUTER_02.getFunction('exactInputSingle')!.selector.toLowerCase();
const SEL_EXACT_INPUT_02 = SWAP_ROUTER_02.getFunction('exactInput')!.selector.toLowerCase();
const SEL_MULTICALL_DEADLINE = SWAP_ROUTER_02.getFunction('multicall(uint256,bytes[])')!.selector.toLowerCase();
const SEL_MULTICALL = SWAP_ROUTER_02.getFunction('multicall(bytes[])')!.selector.toLowerCase();
const SEL_EXACT_INPUT_SINGLE = SWAP_ROUTER.getFunction('exactInputSingle')!.selector.toLowerCase();
const SEL_EXACT_INPUT = SWAP_ROUTER.getFunction('exactInput')!.selector.toLowerCase();
const SEL_V2_EXACT = V2.getFunction('swapExactTokensForTokens')!.selector.toLowerCase();

export type DexStyle = 'uniswap-v2' | 'swap-router' | 'swap-router02';

export interface PinnedDexVenue {
  chainId: number;
  /** Short name used in errors and tests. */
  name: string;
  style: DexStyle;
  router: string;
  factory: string;
  wrappedNative: string;
  /** Selectors a top-level transaction may use. */
  outerSelectors: readonly string[];
  /** Selectors a multicall inner may use. Multicall is not in this list. */
  innerSelectors: readonly string[];
}

/** One unordered token pair. V3 entries also pin the fee tier. V2 entries omit fee. */
export interface DexPoolConfig {
  tokenA: string;
  tokenB: string;
  fee?: number;
}

export interface DexVenueConfig {
  /** Default false. The chain's own enabled flag is separate. */
  enabled?: boolean;
  /** Must equal the pinned router. Omitted uses the pin. */
  router?: string;
  /** Subset of the pinned outer selectors. Omitted uses the pin. */
  selectors?: string[];
  /** Must equal the pinned wrapped native. Omitted uses the pin. */
  wrappedNative?: string;
  /**
   * Required when enabled. A hop is signed only when its pair, and its fee
   * tier on v3, is in this list. The match is unordered.
   */
  pools?: DexPoolConfig[];
  /**
   * Mantle 5000 only. The signer does not read pool reserves. This flag is
   * the operator's acknowledgement that Agni depth was rechecked. The best
   * Agni pool on 18 October 2026 was about $14k, so the venue stays off.
   */
  poolDepthVerified?: boolean;
  /** YYYY-MM-DD of that recheck. Required with poolDepthVerified on Mantle. */
  verifiedAt?: string;
}

interface NormalizedPool {
  tokenA: string;
  tokenB: string;
  fee?: number;
}

export interface DecodedDexSwap {
  selector: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
  recipient: string;
}

export interface DexDecodeInput {
  chainId: number;
  config: DexVenueConfig | undefined;
  wallet: string;
  value: bigint;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  allowRole: (address: string, role: 'token') => boolean;
  nowSec: number;
}

/**
 * Chains that were assessed and left unimplemented. Enabling dex on one of
 * these ids fails startup. The long form of each reason is in
 * docs/signer-multichain.md.
 */
export const DEX_UNSAFE_REASON: Readonly<Record<number, string>> = {
  1284: 'Moonbeam is not safe: no liquid venue was confirmed, and the official Uniswap front-end is deprecated',
  81457: 'Blast is not safe: the liquid Thruster router exposes setManager, and the canonical Uniswap pools are not a treasury venue',
  534352: 'Scroll is not safe: canonical Uniswap is not liquid, and the liquid routers take arbitrary path or callback bytes',
};

function pin(address: string): string {
  return getAddress(address);
}

export const DEX_VENUES: readonly PinnedDexVenue[] = [
  {
    chainId: 25,
    name: 'Cronos VVS',
    style: 'uniswap-v2',
    router: pin('0x145863Eb42Cf62847A6Ca784e6416C1682b1b2Ae'),
    factory: pin('0x3B44B2a187a7b3824131F8db5a74194D0a42Fc15'),
    wrappedNative: pin('0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23'),
    outerSelectors: [SEL_V2_EXACT],
    innerSelectors: [SEL_V2_EXACT],
  },
  {
    chainId: 100,
    name: 'Gnosis Uniswap',
    style: 'swap-router02',
    router: pin('0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be'),
    factory: pin('0xe32F7dD7e3f098D518ff19A22d5f028e076489B1'),
    wrappedNative: pin('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'),
    outerSelectors: [SEL_MULTICALL_DEADLINE],
    innerSelectors: [SEL_EXACT_INPUT_SINGLE_02, SEL_EXACT_INPUT_02],
  },
  {
    chainId: 42220,
    name: 'Celo Uniswap',
    style: 'swap-router02',
    router: pin('0x5615CDAb10dc425a742d643d949a7F474C01abc4'),
    factory: pin('0xAfE208a311B21f13EF87E33A90049fC17A7acDEc'),
    // The router's WETH9() immutable is the zero address. Pools quote the
    // CELO ERC-20, which is the native asset's token representation.
    wrappedNative: pin('0x471EcE3750Da237f93B8E339c536989b8978a438'),
    outerSelectors: [SEL_MULTICALL_DEADLINE],
    innerSelectors: [SEL_EXACT_INPUT_SINGLE_02, SEL_EXACT_INPUT_02],
  },
  {
    chainId: 5000,
    name: 'Mantle Agni',
    style: 'swap-router',
    router: pin('0x319B69888b0d11cEC22caA5034e25FfFBDc88421'),
    factory: pin('0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035'),
    wrappedNative: pin('0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8'),
    outerSelectors: [SEL_EXACT_INPUT_SINGLE, SEL_EXACT_INPUT, SEL_MULTICALL],
    innerSelectors: [SEL_EXACT_INPUT_SINGLE, SEL_EXACT_INPUT],
  },
];

const BY_CHAIN = new Map(DEX_VENUES.map((venue) => [venue.chainId, venue]));
const ZERO = pin('0x0000000000000000000000000000000000000000');

export function dexVenue(chainId: number): PinnedDexVenue | undefined {
  return BY_CHAIN.get(chainId);
}

export function isDexRouter(chainId: number, address: string): boolean {
  const venue = BY_CHAIN.get(chainId);
  if (!venue) return false;
  try {
    return getAddress(address) === venue.router;
  } catch {
    return false;
  }
}

const DEX_KEYS = new Set(['enabled', 'router', 'selectors', 'wrappedNative', 'pools', 'poolDepthVerified', 'verifiedAt']);
const DEX_POOL_KEYS = new Set(['tokenA', 'tokenB', 'fee']);

export function assertDexConfig(config: DexVenueConfig | undefined, chainId: number, label = `chains.${chainId}`): void {
  if (config === undefined) return;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) failConfig(`${label}.dex must be an object`);
  for (const key of Object.keys(config)) {
    if (!DEX_KEYS.has(key)) failConfig(`${label}.dex.${key} is not a DEX setting`);
  }
  for (const pool of config.pools ?? []) {
    if (pool === null || typeof pool !== 'object' || Array.isArray(pool)) failConfig(`${label}.dex.pools entries must be objects`);
    for (const key of Object.keys(pool)) {
      if (!DEX_POOL_KEYS.has(key)) failConfig(`${label}.dex.pools.${key} is not a pool setting`);
    }
  }
  if (config.enabled !== true) return;
  const unsafe = DEX_UNSAFE_REASON[chainId];
  if (unsafe) failConfig(`${label}.dex ${unsafe}`);
  const venue = BY_CHAIN.get(chainId);
  if (!venue) failConfig(`${label}.dex is not available on chain ${chainId}`);
  if (config.router !== undefined && checksum(config.router, `${label}.dex.router`, 'config') !== venue.router) {
    failConfig(`${label}.dex.router does not match the pinned router ${venue.router}`);
  }
  if (config.wrappedNative !== undefined && checksum(config.wrappedNative, `${label}.dex.wrappedNative`, 'config') !== venue.wrappedNative) {
    failConfig(`${label}.dex.wrappedNative does not match the pinned wrapped native ${venue.wrappedNative}`);
  }
  if (config.selectors !== undefined) normalizeOuter(config.selectors, venue, `${label}.dex.selectors`);
  readPools(config, venue, `${label}.dex`, 'config');
  if (chainId === 5000) assertMantleDepth(config, label);
}

/**
 * Agni's DefiLlama headline and the pool balances read on 18 October 2026
 * did not match. Enabling the venue requires an explicit recheck.
 */
function assertMantleDepth(config: DexVenueConfig, label: string): void {
  if (config.poolDepthVerified !== true) {
    failConfig(`${label}.dex pool depth must be rechecked first`);
  }
  if (!isOnOrBeforeToday(config.verifiedAt)) {
    failConfig(`${label}.dex pool depth must be rechecked first; verifiedAt must be a YYYY-MM-DD date on or before today`);
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

export function decodeDexCalldata(to: string, data: string, input: DexDecodeInput, depth = 0): DecodedDexSwap[] {
  if (input.config?.enabled !== true) fail('DEX venue is disabled');
  const venue = BY_CHAIN.get(input.chainId);
  if (!venue || !isDexRouter(input.chainId, to)) fail('DEX router is not the pinned router');
  if (input.config.router !== undefined && checksum(input.config.router, 'DEX router') !== venue.router) {
    fail('DEX router does not match the pinned router');
  }
  if (depth > 1) fail('nested DEX multicall is denied');
  if (depth === 0 && input.value !== 0n) fail('DEX transaction value must be 0');
  const treasury = checksum(input.wallet, 'DEX treasury');
  const selector = selectorOf(data);
  const outer = input.config.selectors === undefined
    ? new Set(venue.outerSelectors)
    : new Set(normalizeOuter(input.config.selectors, venue, 'DEX selectors'));
  if (selector === SEL_MULTICALL || selector === SEL_MULTICALL_DEADLINE) {
    if (depth > 0) fail('nested DEX multicall is denied');
    if (!outer.has(selector)) fail(`DEX selector ${selector} is denied`);
    return decodeMulticall(to, data, selector, input, venue, depth);
  }
  if (depth === 0 && !outer.has(selector)) fail(`DEX selector ${selector} is denied`);
  if (depth > 0 && !venue.innerSelectors.includes(selector)) fail(`DEX selector ${selector} is denied`);
  const swap = decodeSwap(data, selector, venue, treasury, input);
  if (depth === 0) assertIntentTotals([swap], input);
  return [swap];
}

function decodeMulticall(
  to: string,
  data: string,
  selector: string,
  input: DexDecodeInput,
  venue: PinnedDexVenue,
  depth: number,
): DecodedDexSwap[] {
  if (depth > 0) fail('nested DEX multicall is denied');
  const timed = selector === SEL_MULTICALL_DEADLINE;
  // SwapRouter02 puts the deadline on multicall. A bare multicall has none,
  // so it is denied on that style. SwapRouter carries the deadline on each
  // inner swap. VVS has neither multicall selector, so both are denied there.
  if (venue.style === 'swap-router02' && !timed) fail('DEX multicall is missing a deadline');
  const iface = ifaceFor(venue.style);
  const fn = timed ? 'multicall(uint256,bytes[])' : 'multicall(bytes[])';
  const decoded = decodeExact(iface, fn, data);
  if (timed) assertDeadline(asBigint(decoded[0]), input.nowSec);
  const inners = (timed ? decoded[1] : decoded[0]) as string[];
  if (!Array.isArray(inners) || inners.length === 0) fail('DEX multicall has no inner calls');
  const swaps = inners.flatMap((inner) => decodeDexCalldata(to, inner, input, depth + 1));
  assertIntentTotals(swaps, input);
  return swaps;
}

function decodeSwap(
  data: string,
  selector: string,
  venue: PinnedDexVenue,
  treasury: string,
  input: DexDecodeInput,
): DecodedDexSwap {
  if (venue.style === 'uniswap-v2') return decodeV2(data, selector, treasury, input, venue);
  if (venue.style === 'swap-router') return decodeRouterV1(data, selector, treasury, input, venue);
  return decodeRouter02(data, selector, treasury, input, venue);
}

function decodeV2(data: string, selector: string, treasury: string, input: DexDecodeInput, venue: PinnedDexVenue): DecodedDexSwap {
  if (selector !== SEL_V2_EXACT) fail(`DEX selector ${selector} is denied`);
  const decoded = decodeExact(V2, 'swapExactTokensForTokens', data);
  const amountIn = asBigint(decoded[0]);
  const minOut = asBigint(decoded[1]);
  const path = [...(decoded[2] as string[])].map((token) => erc20(token, input));
  const recipient = checksum(String(decoded[3]), 'DEX recipient');
  assertDeadline(asBigint(decoded[4]), input.nowSec);
  assertLeg(path, amountIn, minOut, recipient, treasury, input);
  assertHops(pathHops(path), input.config, venue);
  return { selector, tokenIn: path[0], tokenOut: path[path.length - 1], amountIn, minOut, recipient };
}

function decodeRouterV1(data: string, selector: string, treasury: string, input: DexDecodeInput, venue: PinnedDexVenue): DecodedDexSwap {
  if (selector === SEL_EXACT_INPUT_SINGLE) {
    const decoded = decodeExact(SWAP_ROUTER, 'exactInputSingle', data);
    const params = decoded[0] as Record<string, unknown>;
    const path = [erc20(String(params.tokenIn), input), erc20(String(params.tokenOut), input)];
    const recipient = checksum(String(params.recipient), 'DEX recipient');
    assertDeadline(asBigint(params.deadline), input.nowSec);
    const amountIn = asBigint(params.amountIn);
    const minOut = asBigint(params.amountOutMinimum);
    assertSqrt(params.sqrtPriceLimitX96);
    assertLeg(path, amountIn, minOut, recipient, treasury, input);
    assertHops([{ tokenA: path[0], tokenB: path[1], fee: asFee(params.fee) }], input.config, venue);
    return { selector, tokenIn: path[0], tokenOut: path[1], amountIn, minOut, recipient };
  }
  if (selector === SEL_EXACT_INPUT) {
    const decoded = decodeExact(SWAP_ROUTER, 'exactInput', data);
    const params = decoded[0] as Record<string, unknown>;
    const decodedPath = decodeV3Path(String(params.path), input);
    const recipient = checksum(String(params.recipient), 'DEX recipient');
    assertDeadline(asBigint(params.deadline), input.nowSec);
    const amountIn = asBigint(params.amountIn);
    const minOut = asBigint(params.amountOutMinimum);
    assertLeg(decodedPath.tokens, amountIn, minOut, recipient, treasury, input);
    assertHops(decodedPath.hops, input.config, venue);
    return { selector, tokenIn: decodedPath.tokens[0], tokenOut: decodedPath.tokens[decodedPath.tokens.length - 1], amountIn, minOut, recipient };
  }
  fail(`DEX selector ${selector} is denied`);
}

function decodeRouter02(data: string, selector: string, treasury: string, input: DexDecodeInput, venue: PinnedDexVenue): DecodedDexSwap {
  if (selector === SEL_EXACT_INPUT_SINGLE_02) {
    const decoded = decodeExact(SWAP_ROUTER_02, 'exactInputSingle', data);
    const params = decoded[0] as Record<string, unknown>;
    const path = [erc20(String(params.tokenIn), input), erc20(String(params.tokenOut), input)];
    const recipient = checksum(String(params.recipient), 'DEX recipient');
    const amountIn = asBigint(params.amountIn);
    const minOut = asBigint(params.amountOutMinimum);
    assertSqrt(params.sqrtPriceLimitX96);
    assertLeg(path, amountIn, minOut, recipient, treasury, input);
    assertHops([{ tokenA: path[0], tokenB: path[1], fee: asFee(params.fee) }], input.config, venue);
    return { selector, tokenIn: path[0], tokenOut: path[1], amountIn, minOut, recipient };
  }
  if (selector === SEL_EXACT_INPUT_02) {
    const decoded = decodeExact(SWAP_ROUTER_02, 'exactInput', data);
    const params = decoded[0] as Record<string, unknown>;
    const decodedPath = decodeV3Path(String(params.path), input);
    const recipient = checksum(String(params.recipient), 'DEX recipient');
    const amountIn = asBigint(params.amountIn);
    const minOut = asBigint(params.amountOutMinimum);
    assertLeg(decodedPath.tokens, amountIn, minOut, recipient, treasury, input);
    assertHops(decodedPath.hops, input.config, venue);
    return { selector, tokenIn: decodedPath.tokens[0], tokenOut: decodedPath.tokens[decodedPath.tokens.length - 1], amountIn, minOut, recipient };
  }
  fail(`DEX selector ${selector} is denied`);
}

function assertIntentTotals(swaps: DecodedDexSwap[], input: DexDecodeInput): void {
  if (input.amountIn === undefined) fail('DEX swap requires amountIn');
  let sum = 0n;
  for (const swap of swaps) sum += swap.amountIn;
  if (sum !== input.amountIn) fail('DEX amountIn does not match the intent');
}

function assertLeg(
  path: string[],
  amountIn: bigint,
  minOut: bigint,
  recipient: string,
  treasury: string,
  input: DexDecodeInput,
): void {
  if (path.length < 2 || path.length > 3) fail('DEX path must contain 2 or 3 tokens');
  if (amountIn <= 0n) fail('DEX amountIn must be greater than zero');
  if (minOut <= 0n) fail('DEX amountOutMin must be greater than zero');
  if (recipient !== treasury) fail('DEX recipient is not the treasury');
  if (!input.tokenIn) fail('DEX swap requires tokenIn');
  if (!input.tokenOut) fail('DEX swap requires tokenOut');
  const tokenIn = checksum(input.tokenIn, 'DEX tokenIn');
  const tokenOut = checksum(input.tokenOut, 'DEX tokenOut');
  if (path[0] !== tokenIn) fail('DEX path tokenIn does not match the intent');
  if (path[path.length - 1] !== tokenOut) fail('DEX path tokenOut does not match the intent');
}

function pathHops(path: string[]): NormalizedPool[] {
  const hops: NormalizedPool[] = [];
  for (let i = 1; i < path.length; i += 1) hops.push({ tokenA: path[i - 1], tokenB: path[i] });
  return hops;
}

function assertHops(hops: NormalizedPool[], config: DexVenueConfig | undefined, venue: PinnedDexVenue): void {
  if (!config) fail('DEX pool allowlist is empty');
  const pools = readPools(config, venue, 'DEX', 'runtime');
  for (const hop of hops) {
    const allowed = pools.some((pool) => samePair(pool, hop) && pool.fee === hop.fee);
    if (!allowed) fail('DEX pool is not allowlisted');
  }
}

function readPools(
  config: DexVenueConfig,
  venue: PinnedDexVenue,
  label: string,
  mode: 'runtime' | 'config',
): NormalizedPool[] {
  const reject: (message: string) => never = mode === 'config' ? failConfig : fail;
  const prefix = mode === 'config' ? `${label}.pools` : 'DEX pool allowlist';
  const raw = config.pools;
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(mode === 'config' ? `${prefix} must list at least one pool` : 'DEX pool allowlist is empty');
  }
  const v2 = venue.style === 'uniswap-v2';
  const out: NormalizedPool[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) reject(`${prefix} must be a list of pool objects`);
    const tokenA = checksum(String(entry.tokenA), `${prefix} tokenA`, mode);
    const tokenB = checksum(String(entry.tokenB), `${prefix} tokenB`, mode);
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

function samePair(left: NormalizedPool, right: NormalizedPool): boolean {
  return (left.tokenA === right.tokenA && left.tokenB === right.tokenB)
    || (left.tokenA === right.tokenB && left.tokenB === right.tokenA);
}

function poolKey(tokenA: string, tokenB: string, fee: number | undefined): string {
  const [a, b] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
  return `${a}|${b}|${fee ?? ''}`;
}

function assertSqrt(value: unknown): void {
  if (asBigint(value) !== 0n) fail('DEX sqrtPriceLimitX96 must be 0');
}

function asFee(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffffffn) fail('DEX fee tier could not be decoded');
    return Number(value);
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  fail('DEX fee tier could not be decoded');
}

/** Uniswap v3 packed path: token (20) + fee (3) + token, at most three tokens. */
function decodeV3Path(path: string, input: DexDecodeInput): { tokens: string[]; hops: NormalizedPool[] } {
  const hex = path.startsWith('0x') || path.startsWith('0X') ? path.slice(2) : path;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) fail('DEX path could not be decoded');
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 43) fail('DEX path could not be decoded');
  const tokens: string[] = [];
  const hops: NormalizedPool[] = [];
  let offset = 0;
  let pendingFee: number | undefined;
  while (offset < bytes.length) {
    if (bytes.length - offset < 20) fail('DEX path could not be decoded');
    const token = erc20(`0x${bytes.subarray(offset, offset + 20).toString('hex')}`, input);
    if (tokens.length > 0) {
      if (pendingFee === undefined) fail('DEX path could not be decoded');
      hops.push({ tokenA: tokens[tokens.length - 1], tokenB: token, fee: pendingFee });
      pendingFee = undefined;
    }
    tokens.push(token);
    offset += 20;
    if (offset === bytes.length) break;
    if (bytes.length - offset < 23) fail('DEX path could not be decoded');
    pendingFee = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
    offset += 3;
  }
  if (pendingFee !== undefined) fail('DEX path could not be decoded');
  if (tokens.length < 2 || tokens.length > 3) fail('DEX path must contain 2 or 3 tokens');
  return { tokens, hops };
}

function erc20(token: string, input: DexDecodeInput): string {
  const address = checksum(token, 'DEX path token');
  if (address === ZERO) fail('DEX path token is not allowlisted');
  if (!input.allowRole(address, 'token')) fail('DEX path token is not allowlisted');
  return address;
}

function assertDeadline(deadline: bigint, nowSec: number): void {
  const now = BigInt(nowSec);
  if (deadline <= now) fail('DEX deadline is not in the future');
  if (deadline > now + BigInt(DEX_MAX_DEADLINE_SEC)) fail('DEX deadline is more than 10 minutes ahead');
}

function ifaceFor(style: DexStyle): Interface {
  if (style === 'uniswap-v2') return V2;
  if (style === 'swap-router') return SWAP_ROUTER;
  return SWAP_ROUTER_02;
}

function decodeExact(iface: Interface, name: string, data: string): ReadonlyArray<unknown> {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = iface.decodeFunctionData(name, data);
  } catch {
    fail(`DEX calldata for ${name} could not be decoded`);
  }
  const again = iface.encodeFunctionData(name, decoded);
  if (again.toLowerCase() !== data.toLowerCase()) fail('DEX calldata has trailing bytes');
  return decoded;
}

function normalizeOuter(list: string[], venue: PinnedDexVenue, label: string): string[] {
  if (!Array.isArray(list) || list.length === 0) failConfig(`${label} must be a non-empty selector list`);
  const allowed = new Set(venue.outerSelectors);
  const out: string[] = [];
  for (const selector of list) {
    const normalized = String(selector).toLowerCase();
    if (!/^0x[0-9a-f]{8}$/.test(normalized)) failConfig(`${label} has an invalid selector`);
    if (!allowed.has(normalized)) failConfig(`${label} has ${normalized} which is not a pinned selector`);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function selectorOf(data: string): string {
  const normalized = (data ?? '0x').toLowerCase();
  if (normalized.length < 10) return normalized;
  return normalized.slice(0, 10);
}

function asBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  fail('DEX amount could not be decoded');
}

function checksum(address: string, label: string, mode: 'runtime' | 'config' = 'runtime'): string {
  try {
    return getAddress(address);
  } catch {
    if (mode === 'config') failConfig(`${label} is not an address`);
    fail(`${label} is not an address`);
  }
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}

function failConfig(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}
