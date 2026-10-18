/**
 * Uniswap v3 concentrated-liquidity module on Avalanche C-Chain.
 *
 * Disabled unless chains[43114].clmm.enabled is true. The position manager
 * and the WAVAX/USDC 0.05% pool are pinned. Mint is restricted to an
 * allowlisted (token0, token1, fee) with tick bounds and amount caps from
 * config. NFT transfer and approval selectors stay blocked.
 */

import { Interface, MaxUint256, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { SigningIntent } from './intent';

export const AVALANCHE_UNISWAP_V3_FACTORY = '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD';
export const AVALANCHE_UNISWAP_V3_NPM = '0x655C406EBFa14EE2006250925e54ec43AD184f8B';
export const AVALANCHE_WAVAX_USDC_POOL = '0xfae3f424a0a47706811521e3ee268f00cfb5c45e';
export const AVALANCHE_WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';
export const AVALANCHE_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
export const AVALANCHE_POOL_FEE = 500;
export const AVALANCHE_POOL_TICK_SPACING = 10;
export const CLMM_CHAIN_ID = 43114;
/** Mint and decrease deadlines must fall inside ten minutes. */
export const CLMM_MAX_DEADLINE_SEC = 600;

export interface ClmmPoolConfig {
  pool: string;
  token0: string;
  token1: string;
  fee: number;
  tickSpacing?: number;
  tickLowerMin: number;
  tickLowerMax: number;
  tickUpperMin: number;
  tickUpperMax: number;
  /** Raw token caps for amount0Desired / amount1Desired and ERC-20 approves. */
  amount0Cap: string;
  amount1Cap: string;
}

export interface ClmmModuleConfig {
  enabled?: boolean;
  /** increaseLiquidity stays blocked unless this is true. */
  increaseLiquidity?: boolean;
  pools?: ClmmPoolConfig[];
}

export interface DecodedClmmCall {
  op: 'approve' | 'mint' | 'increase' | 'decrease' | 'collect' | 'burn';
  token?: string;
  amount?: bigint;
  token0?: string;
  token1?: string;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  amount0?: bigint;
  amount1?: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
  recipient?: string;
  deadline?: bigint;
  tokenId?: bigint;
}

const NPM = new Interface([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable',
  'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
]);

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount)',
]);

const NPM_ADDRESS = getAddress(AVALANCHE_UNISWAP_V3_NPM);
const WAVAX = getAddress(AVALANCHE_WAVAX);
const USDC = getAddress(AVALANCHE_USDC);
const POOL = getAddress(AVALANCHE_WAVAX_USDC_POOL);
const FACTORY = getAddress(AVALANCHE_UNISWAP_V3_FACTORY);
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const BLOCKED: Record<string, string> = {
  [NPM.getFunction('approve')!.selector]: 'NFT approve is denied',
  [NPM.getFunction('setApprovalForAll')!.selector]: 'NFT setApprovalForAll is denied',
  [NPM.getFunction('transferFrom')!.selector]: 'NFT transferFrom is denied',
  [NPM.getFunction('safeTransferFrom(address,address,uint256)')!.selector]: 'NFT safeTransferFrom is denied',
  [NPM.getFunction('safeTransferFrom(address,address,uint256,bytes)')!.selector]: 'NFT safeTransferFrom is denied',
};

function reject(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}

function rejectConfig(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}

function selectorOf(data: string): string {
  const normalized = (data ?? '0x').toLowerCase();
  if (normalized.length < 10) return normalized;
  return normalized.slice(0, 10);
}

export function isClmmPositionManager(address: string): boolean {
  try {
    return getAddress(address) === NPM_ADDRESS;
  } catch {
    return false;
  }
}

/** ERC-20 approve of WAVAX or USDC to the position manager. Other spenders stay on the normal path. */
export function isClmmNpmApprove(to: string, data: string): boolean {
  try {
    const token = getAddress(to);
    if (token !== WAVAX && token !== USDC) return false;
  } catch {
    return false;
  }
  if (selectorOf(data) !== ERC20.getFunction('approve')!.selector) return false;
  try {
    const decoded = ERC20.decodeFunctionData('approve', data);
    return getAddress(String(decoded[0])) === NPM_ADDRESS;
  } catch {
    return false;
  }
}

export function clmmEnabled(config: ClmmModuleConfig | undefined): boolean {
  return config?.enabled === true;
}

export function assertClmmConfig(config: ClmmModuleConfig | undefined, chainId: number): void {
  if (!config?.enabled) return;
  if (chainId !== CLMM_CHAIN_ID) rejectConfig('CLMM module is only supported on chain 43114');
  if (!config.pools || config.pools.length === 0) rejectConfig('clmm.pools must list at least one pool');
  for (const pool of config.pools) {
    const poolAddress = checksum(pool.pool, 'clmm.pool');
    const token0 = checksum(pool.token0, 'clmm.token0');
    const token1 = checksum(pool.token1, 'clmm.token1');
    if (token0.toLowerCase() >= token1.toLowerCase()) rejectConfig('clmm token0 must sort before token1');
    if (!Number.isSafeInteger(pool.fee) || pool.fee <= 0) rejectConfig('clmm.fee must be a positive integer');
    if (poolAddress === POOL) {
      if (token0 !== WAVAX || token1 !== USDC || pool.fee !== AVALANCHE_POOL_FEE) {
        rejectConfig('WAVAX/USDC 0.05% pool fields do not match the pinned pool');
      }
    }
    const spacing = pool.tickSpacing ?? (pool.fee === AVALANCHE_POOL_FEE ? AVALANCHE_POOL_TICK_SPACING : undefined);
    if (!Number.isSafeInteger(spacing) || (spacing ?? 0) <= 0) rejectConfig('clmm.tickSpacing must be a positive integer');
    for (const bound of ['tickLowerMin', 'tickLowerMax', 'tickUpperMin', 'tickUpperMax'] as const) {
      if (!Number.isSafeInteger(pool[bound])) rejectConfig(`clmm.${bound} must be an integer`);
    }
    if (pool.tickLowerMin > pool.tickLowerMax || pool.tickUpperMin > pool.tickUpperMax) {
      rejectConfig('clmm tick bounds are reversed');
    }
    if (!DECIMAL.test(pool.amount0Cap) || !DECIMAL.test(pool.amount1Cap)) {
      rejectConfig('clmm amount caps must be decimal strings');
    }
  }
  void FACTORY;
}

function checksum(address: string, label: string): string {
  try {
    return getAddress(address);
  } catch {
    rejectConfig(`${label} is not an address`);
  }
}

export function clmmFundingTokens(): { wavax: string; usdc: string; npm: string } {
  return { wavax: WAVAX, usdc: USDC, npm: NPM_ADDRESS };
}

export function decodeClmmCalldata(
  to: string,
  data: string,
  config: ClmmModuleConfig | undefined,
  wallet: string,
  value: bigint,
  nowSec: number,
  intent: SigningIntent | undefined,
  depth = 0,
): DecodedClmmCall[] {
  if (!clmmEnabled(config)) reject('CLMM module is disabled');
  if (value !== 0n) reject('CLMM transaction value must be 0');
  const target = getAddress(to);
  if (target === WAVAX || target === USDC) return [decodeApprove(target, data, config)];
  if (target !== NPM_ADDRESS) reject('CLMM call target is not the position manager or a funding token');
  if (depth > 1) reject('nested CLMM multicall is denied');
  const selector = selectorOf(data);
  const blocked = BLOCKED[selector];
  if (blocked) reject(blocked);
  if (selector === NPM.getFunction('increaseLiquidity')!.selector && config?.increaseLiquidity !== true) {
    reject('increaseLiquidity is disabled');
  }
  if (selector === NPM.getFunction('multicall')!.selector) {
    const decoded = decodeExact(NPM, 'multicall', data);
    const inners = decoded[0] as string[];
    if (!Array.isArray(inners) || inners.length === 0) reject('CLMM multicall has no inner calls');
    return inners.flatMap((inner) => decodeClmmCalldata(to, inner, config, wallet, 0n, nowSec, intent, depth + 1));
  }
  if (selector === NPM.getFunction('mint')!.selector) return [decodeMint(data, config, wallet, nowSec)];
  if (selector === NPM.getFunction('collect')!.selector) return [decodeCollect(data, wallet, intent)];
  if (selector === NPM.getFunction('decreaseLiquidity')!.selector) return [decodeDecrease(data, nowSec, intent)];
  if (selector === NPM.getFunction('burn')!.selector) return [decodeBurn(data, intent)];
  if (selector === NPM.getFunction('increaseLiquidity')!.selector) return [decodeIncrease(data, config, nowSec, intent)];
  reject(`CLMM selector ${selector} is denied`);
}

function decodeApprove(token: string, data: string, config: ClmmModuleConfig | undefined): DecodedClmmCall {
  if (selectorOf(data) !== ERC20.getFunction('approve')!.selector) reject('funding token call is not an exact approve');
  const decoded = decodeExact(ERC20, 'approve', data);
  const spender = getAddress(String(decoded[0]));
  const amount = asBigInt(decoded[1]);
  if (spender !== NPM_ADDRESS) reject('approve spender is not the position manager');
  if (amount <= 0n) reject('approve amount must be positive');
  if (amount === MaxUint256) reject('Unlimited ERC-20 approval is denied');
  const cap = capFor(token, config);
  if (amount > cap) reject('approve amount exceeds the CLMM cap');
  return { op: 'approve', token, amount };
}

function decodeMint(data: string, config: ClmmModuleConfig | undefined, wallet: string, nowSec: number): DecodedClmmCall {
  const decoded = decodeExact(NPM, 'mint', data);
  const params = decoded[0] as {
    token0: string;
    token1: string;
    fee: number | bigint;
    tickLower: number | bigint;
    tickUpper: number | bigint;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: string;
    deadline: bigint;
  };
  const token0 = getAddress(params.token0);
  const token1 = getAddress(params.token1);
  const fee = Number(params.fee);
  const pool = findPool(config, token0, token1, fee);
  const tickLower = Number(params.tickLower);
  const tickUpper = Number(params.tickUpper);
  assertTicks(pool, tickLower, tickUpper);
  const amount0 = BigInt(params.amount0Desired);
  const amount1 = BigInt(params.amount1Desired);
  const amount0Min = BigInt(params.amount0Min);
  const amount1Min = BigInt(params.amount1Min);
  if (amount0 <= 0n && amount1 <= 0n) reject('mint amounts must be positive');
  if (amount0 > BigInt(pool.amount0Cap) || amount1 > BigInt(pool.amount1Cap)) reject('mint amount exceeds the CLMM cap');
  if (amount0 > 0n && amount0Min <= 0n) reject('mint amount0Min must be nonzero');
  if (amount1 > 0n && amount1Min <= 0n) reject('mint amount1Min must be nonzero');
  if (amount0Min <= 0n && amount1Min <= 0n) reject('mint amountMin must be nonzero');
  const recipient = getAddress(params.recipient);
  if (recipient !== getAddress(wallet)) reject('mint recipient is not the treasury');
  assertDeadline(BigInt(params.deadline), nowSec);
  return {
    op: 'mint', token0, token1, fee, tickLower, tickUpper, amount0, amount1, amount0Min, amount1Min, recipient,
    deadline: BigInt(params.deadline),
  };
}

function decodeIncrease(data: string, config: ClmmModuleConfig | undefined, nowSec: number, intent: SigningIntent | undefined): DecodedClmmCall {
  const decoded = decodeExact(NPM, 'increaseLiquidity', data);
  const params = decoded[0] as {
    tokenId: bigint;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    deadline: bigint;
  };
  const tokenId = BigInt(params.tokenId);
  assertOwned(tokenId, intent);
  const amount0 = BigInt(params.amount0Desired);
  const amount1 = BigInt(params.amount1Desired);
  const amount0Min = BigInt(params.amount0Min);
  const amount1Min = BigInt(params.amount1Min);
  const pool = (config?.pools ?? [])[0];
  if (!pool) reject('CLMM pool is not configured');
  if (amount0 > BigInt(pool.amount0Cap) || amount1 > BigInt(pool.amount1Cap)) reject('increaseLiquidity amount exceeds the CLMM cap');
  if (amount0 > 0n && amount0Min <= 0n) reject('increaseLiquidity amount0Min must be nonzero');
  if (amount1 > 0n && amount1Min <= 0n) reject('increaseLiquidity amount1Min must be nonzero');
  assertDeadline(BigInt(params.deadline), nowSec);
  return { op: 'increase', tokenId, amount0, amount1, amount0Min, amount1Min, deadline: BigInt(params.deadline) };
}

function decodeDecrease(data: string, nowSec: number, intent: SigningIntent | undefined): DecodedClmmCall {
  const decoded = decodeExact(NPM, 'decreaseLiquidity', data);
  const params = decoded[0] as {
    tokenId: bigint;
    liquidity: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    deadline: bigint;
  };
  const tokenId = BigInt(params.tokenId);
  assertOwned(tokenId, intent);
  if (BigInt(params.liquidity) <= 0n) reject('decreaseLiquidity liquidity must be positive');
  const amount0Min = BigInt(params.amount0Min);
  const amount1Min = BigInt(params.amount1Min);
  if (amount0Min <= 0n && amount1Min <= 0n) reject('decreaseLiquidity amountMin must be nonzero');
  assertDeadline(BigInt(params.deadline), nowSec);
  return { op: 'decrease', tokenId, amount0Min, amount1Min, deadline: BigInt(params.deadline) };
}

function decodeCollect(data: string, wallet: string, intent: SigningIntent | undefined): DecodedClmmCall {
  const decoded = decodeExact(NPM, 'collect', data);
  const params = decoded[0] as { tokenId: bigint; recipient: string; amount0Max: bigint; amount1Max: bigint };
  const tokenId = BigInt(params.tokenId);
  assertOwned(tokenId, intent);
  const recipient = getAddress(params.recipient);
  if (recipient !== getAddress(wallet)) reject('collect recipient is not the treasury');
  if (BigInt(params.amount0Max) <= 0n && BigInt(params.amount1Max) <= 0n) reject('collect amountMax must be nonzero');
  return { op: 'collect', tokenId, recipient };
}

function decodeBurn(data: string, intent: SigningIntent | undefined): DecodedClmmCall {
  const decoded = decodeExact(NPM, 'burn', data);
  const tokenId = asBigInt(decoded[0]);
  assertOwned(tokenId, intent);
  return { op: 'burn', tokenId };
}

function findPool(config: ClmmModuleConfig | undefined, token0: string, token1: string, fee: number): ClmmPoolConfig {
  const pool = (config?.pools ?? []).find((entry) => (
    getAddress(entry.token0) === token0 && getAddress(entry.token1) === token1 && entry.fee === fee
  ));
  if (!pool) reject('mint pool is not allowlisted');
  return pool;
}

function assertTicks(pool: ClmmPoolConfig, tickLower: number, tickUpper: number): void {
  const spacing = pool.tickSpacing ?? AVALANCHE_POOL_TICK_SPACING;
  if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) reject('ticks are not on the pool spacing');
  if (tickLower >= tickUpper) reject('tickLower must be below tickUpper');
  if (tickLower < pool.tickLowerMin || tickLower > pool.tickLowerMax) reject('tickLower is outside the configured bounds');
  if (tickUpper < pool.tickUpperMin || tickUpper > pool.tickUpperMax) reject('tickUpper is outside the configured bounds');
}

function assertDeadline(deadline: bigint, nowSec: number): void {
  const now = BigInt(nowSec);
  if (deadline <= now) reject('CLMM deadline is not in the future');
  if (deadline > now + BigInt(CLMM_MAX_DEADLINE_SEC)) reject('CLMM deadline exceeds 10 minutes');
}

function assertOwned(tokenId: bigint, intent: SigningIntent | undefined): void {
  const owned = intent?.clmm?.ownedTokenIds ?? [];
  if (!owned.some((id) => DECIMAL.test(id) && BigInt(id) === tokenId)) {
    reject('tokenId is not a treasury-owned position');
  }
}

function capFor(token: string, config: ClmmModuleConfig | undefined): bigint {
  const pool = (config?.pools ?? []).find((entry) => (
    getAddress(entry.token0) === token || getAddress(entry.token1) === token
  ));
  if (!pool) reject('funding token is not in an allowlisted pool');
  return getAddress(pool.token0) === token ? BigInt(pool.amount0Cap) : BigInt(pool.amount1Cap);
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') return BigInt(value);
  reject('CLMM amount could not be decoded');
}

function decodeExact(iface: Interface, name: string, data: string): ReadonlyArray<unknown> {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = iface.decodeFunctionData(name, data);
  } catch {
    reject(`CLMM calldata for ${name} could not be decoded`);
  }
  const again = iface.encodeFunctionData(name, decoded);
  if (again.toLowerCase() !== data.toLowerCase()) reject('CLMM calldata has trailing bytes');
  return decoded;
}
