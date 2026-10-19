/**
 * Polymarket module. Disabled unless chains[137].polymarket.enabled is true.
 *
 * Orders are a dedicated kind, not generic typed data. The signed Order has
 * no expiration, nonce, feeRateBps, or taker. Those wire-body fields are not
 * enforceable here. The intent's orderType must still be FOK so the approval
 * binds that declaration.
 */

import { Interface, getAddress, id } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { SigningIntent, TypedDataPayload } from './intent';
import {
  PM_CHAIN_ID,
  PM_CLOB_AUTH_DOMAIN,
  PM_CLOB_AUTH_FIELDS,
  PM_CLOB_AUTH_MESSAGE,
  PM_CLOB_AUTH_VERSION,
  PM_CTF,
  PM_CTF_EXCHANGE_V1,
  PM_CTF_EXCHANGE_V2,
  PM_DOMAIN_NAME,
  PM_DOMAIN_VERSION_V2,
  PM_DOMAIN_VERSION_V3,
  PM_EXCHANGE_V3,
  PM_NEG_RISK_ADAPTER,
  PM_NEG_RISK_EXCHANGE_V1,
  PM_NEG_RISK_EXCHANGE_V2,
  PM_ORDER_FIELDS,
  PM_ORDER_TYPE,
  PM_ORDER_TYPEHASH,
  PM_PUSD,
  PM_TIMESTAMP_SKEW_MS,
  PM_USDC_E,
  PM_ZERO_BYTES32,
  POLYMARKET_DENY_CONTRACTS,
} from './polymarket-addresses';

export interface PolymarketMarket {
  tokenId: string;
  conditionId: string;
  negRisk: boolean;
}

export interface PolymarketModuleConfig {
  enabled?: boolean;
  /** Domain version "3" and the V3 exchange. Default denied. */
  v3Exchange?: boolean;
  /** L1 ClobAuth signatures. Default denied, separate from orders. */
  clobAuth?: boolean;
  /** Hard ceilings in percent of NAV. A proposer cap may only go lower. */
  perOrderPctNav?: number;
  perMarketPctNav?: number;
  totalOpenPctNav?: number;
  /** Absolute price band around the verifier mid. Default 0.02. */
  priceBand?: number;
  maxOrdersPerDay?: number;
  /** bytes32. Default is the zero word. */
  builder?: string;
  metadata?: string;
  markets?: PolymarketMarket[];
  /** Default false. When true, SELL orders and setApprovalForAll(operator, true) are denied. */
  buyOnly?: boolean;
  /** Hard per-order USD ceiling. Omitted leaves only the NAV percent caps. */
  maxOrderUsd?: string;
  /** Hard UTC-day USD ceiling, persisted with the nonce file. Omitted leaves only the NAV percent caps. */
  maxDailyUsd?: string;
  /** Default false. When true, CTF setApprovalForAll(v1Operator, false) can be revoked. */
  revokeV1Ctf?: boolean;
}

export interface PolymarketOrderIntent {
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  limitPrice: string;
  size: string;
  notionalUsd: string;
  orderType: string;
  negRisk: boolean;
  verifyingContract: string;
  mid: string;
  /** Raw conditional-token balance. Required for SELL. */
  balance?: string;
  navUsd: string;
  marketOpenUsd: string;
  totalOpenUsd: string;
  perOrderPctNav?: number;
  perMarketPctNav?: number;
  totalOpenPctNav?: number;
}

export interface ClobAuthIntent {
  timestamp: string;
}

export interface PolymarketReplayState {
  hasHash(hash: string): boolean;
  hasSalt(salt: string): boolean;
  countSince(atMs: number): number;
  /** Collateral micros already signed for orders since `atMs`. Records without a stored amount count as zero. */
  spentSince(atMs: number): bigint;
}

const CTF = new Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
]);

const NEG_RISK = new Interface([
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
]);

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount)',
]);

const EXCHANGE = new Interface([
  'function pauseUser()',
]);

const DENIED = new Set(POLYMARKET_DENY_CONTRACTS.map((address) => getAddress(address)));
const COLLATERAL = new Set([getAddress(PM_USDC_E), getAddress(PM_PUSD)]);
const V1_STANDARD = getAddress(PM_CTF_EXCHANGE_V1);
const V1_NEG_RISK = getAddress(PM_NEG_RISK_EXCHANGE_V1);
const V2_STANDARD = getAddress(PM_CTF_EXCHANGE_V2);
const V2_NEG_RISK = getAddress(PM_NEG_RISK_EXCHANGE_V2);
const V3_EXCHANGE = getAddress(PM_EXCHANGE_V3);
const CTF_ADDRESS = getAddress(PM_CTF);
const ADAPTER = getAddress(PM_NEG_RISK_ADAPTER);
const PUSD = getAddress(PM_PUSD);
const USDC_E = getAddress(PM_USDC_E);

function reject(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}

function selectorOf(data: string): string {
  const normalized = (data ?? '0x').toLowerCase();
  if (normalized === '0x' || normalized.length < 10) return normalized.slice(0, 10);
  return normalized.slice(0, 10);
}

export function polymarketOrderTypehash(): string {
  return id(PM_ORDER_TYPE);
}

export function isPolymarketDeniedAddress(address: string): boolean {
  try {
    return DENIED.has(getAddress(address));
  } catch {
    return false;
  }
}

export function isPolymarketCollateral(address: string): boolean {
  try {
    return COLLATERAL.has(getAddress(address));
  } catch {
    return false;
  }
}

/** ERC-20 approve of USDC.e or pUSD whose spender is a Polymarket protocol contract. */
export function isPolymarketCollateralApprove(to: string, data: string): boolean {
  if (!isPolymarketCollateral(to)) return false;
  if (selectorOf(data) !== ERC20.getFunction('approve')!.selector) return false;
  try {
    const decoded = ERC20.decodeFunctionData('approve', data);
    return isPolymarketDeniedAddress(String(decoded[0]));
  } catch {
    return false;
  }
}

export function assertPolymarketConfig(config: PolymarketModuleConfig | undefined, label: string): void {
  if (!config?.enabled) return;
  for (const name of ['perOrderPctNav', 'perMarketPctNav', 'totalOpenPctNav'] as const) {
    const value = config[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      rejectConfig(`${label}.${name} must be a percent from 0 to 100`);
    }
  }
  if (!Number.isSafeInteger(config.maxOrdersPerDay) || (config.maxOrdersPerDay ?? -1) < 0) {
    rejectConfig(`${label}.maxOrdersPerDay must be a non-negative integer`);
  }
  if (config.priceBand !== undefined && (!Number.isFinite(config.priceBand) || config.priceBand < 0 || config.priceBand > 1)) {
    rejectConfig(`${label}.priceBand must be between 0 and 1`);
  }
  for (const word of [config.builder, config.metadata]) {
    if (word !== undefined && !isBytes32(word)) rejectConfig(`${label} builder and metadata must be bytes32`);
  }
  for (const market of config.markets ?? []) {
    if (!DECIMAL.test(market.tokenId)) rejectConfig(`${label}.markets tokenId must be a decimal string`);
    if (!isBytes32(market.conditionId)) rejectConfig(`${label}.markets conditionId must be bytes32`);
    if (typeof market.negRisk !== 'boolean') rejectConfig(`${label}.markets negRisk must be boolean`);
  }
  if (config.buyOnly !== undefined && typeof config.buyOnly !== 'boolean') {
    rejectConfig(`${label}.buyOnly must be a boolean`);
  }
  if (config.revokeV1Ctf !== undefined && typeof config.revokeV1Ctf !== 'boolean') {
    rejectConfig(`${label}.revokeV1Ctf must be a boolean`);
  }
  if (config.maxOrderUsd !== undefined && !USD.test(config.maxOrderUsd)) {
    rejectConfig(`${label}.maxOrderUsd must be a USD amount`);
  }
  if (config.maxDailyUsd !== undefined && !USD.test(config.maxDailyUsd)) {
    rejectConfig(`${label}.maxDailyUsd must be a USD amount`);
  }
}

function rejectConfig(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const USD = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

export function moduleEnabled(config: PolymarketModuleConfig | undefined): boolean {
  return config?.enabled === true;
}

function sameFields(actual: Array<{ name: string; type: string }> | undefined, expected: ReadonlyArray<{ name: string; type: string }>): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return expected.every((field, index) => actual[index]?.name === field.name && actual[index]?.type === field.type);
}

function domainKeys(domain: Record<string, unknown>): string[] {
  return Object.keys(domain).filter((key) => domain[key] !== undefined);
}

function isBytes32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function uint256(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && DECIMAL.test(value)) return BigInt(value);
  reject(`${label} must be a decimal uint256`);
}

function priceMicros(text: string, label: string): bigint {
  if (!USD.test(text)) reject(`${label} must be a USD amount`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

function effectivePct(configPct: number, proposer: number | undefined, label: string): number {
  if (proposer === undefined) return configPct;
  if (!Number.isFinite(proposer) || proposer < 0 || proposer > 100) reject(`${label} must be a percent from 0 to 100`);
  if (proposer > configPct) reject(`${label} loosens the hard ceiling`);
  return proposer;
}

function pctHolds(amount: bigint, nav: bigint, pct: number): boolean {
  const bps = BigInt(Math.round(pct * 100));
  return amount * 10_000n <= nav * bps;
}

function exchangeFor(negRisk: boolean, v3: boolean, verifying: string): void {
  if (v3) {
    if (verifying !== V3_EXCHANGE) reject('v3 order verifyingContract is not the V3 exchange');
    return;
  }
  const expected = negRisk ? V2_NEG_RISK : V2_STANDARD;
  if (verifying !== expected) reject('negRisk does not match verifyingContract');
}

export function assertPolymarketOrder(args: {
  config: PolymarketModuleConfig;
  typed: TypedDataPayload;
  intent: SigningIntent;
  wallet: string;
  now: number;
  orderHash: string;
  state: PolymarketReplayState;
}): void {
  const config = args.config;
  if (!moduleEnabled(config)) reject('Polymarket is denied and cannot be enabled by config');
  const order = args.intent.polymarket;
  if (!order) reject('polymarket order intent is missing');
  if (polymarketOrderTypehash() !== PM_ORDER_TYPEHASH) reject('Order typehash constant does not match the type string');
  const types = args.typed.types ?? {};
  const typeNames = Object.keys(types).filter((name) => name !== 'EIP712Domain');
  if (typeNames.length !== 1 || typeNames[0] !== 'Order' || !sameFields(types.Order, PM_ORDER_FIELDS)) {
    reject('Order type schema does not match');
  }
  const domain = args.typed.domain ?? {};
  const keys = domainKeys(domain).sort();
  if (keys.join(',') !== 'chainId,name,verifyingContract,version') reject('Order domain fields do not match');
  if (domain.name !== PM_DOMAIN_NAME) reject('Order domain name does not match');
  if (Number(domain.chainId) !== PM_CHAIN_ID) reject('Order domain chainId is not 137');
  let verifying: string;
  try {
    verifying = getAddress(String(domain.verifyingContract));
  } catch {
    reject('Order verifyingContract is not an address');
  }
  const version = String(domain.version);
  const v3 = version === PM_DOMAIN_VERSION_V3;
  if (version !== PM_DOMAIN_VERSION_V2 && !v3) reject('Order domain version does not match');
  if (v3 && config.v3Exchange !== true) reject('Polymarket V3 exchange is denied');
  if (!v3 && version !== PM_DOMAIN_VERSION_V2) reject('Order domain version does not match');
  if (getAddress(order.verifyingContract) !== verifying) reject('intent verifyingContract does not match the domain');
  exchangeFor(order.negRisk, v3, verifying);

  const value = args.typed.value ?? {};
  const valueKeys = Object.keys(value);
  if (valueKeys.length !== PM_ORDER_FIELDS.length || PM_ORDER_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field.name))) {
    reject('Order value fields do not match');
  }
  const maker = addressField(value.maker, 'maker');
  const signer = addressField(value.signer, 'signer');
  const treasury = getAddress(args.wallet);
  if (maker !== treasury || signer !== treasury) reject('maker and signer must both be the treasury');
  if (uint256(value.signatureType, 'signatureType') !== 0n) reject('signatureType must be 0');
  const side = uint256(value.side, 'side');
  if (side !== 0n && side !== 1n) reject('side must be 0 or 1');
  const sideName = side === 0n ? 'BUY' : 'SELL';
  if (order.side !== sideName) reject('intent side does not match the order');
  if (config.buyOnly === true && sideName === 'SELL') reject('buyOnly denies SELL');
  const metadata = wordField(value.metadata, 'metadata');
  const builder = wordField(value.builder, 'builder');
  const pinnedMeta = (config.metadata ?? PM_ZERO_BYTES32).toLowerCase();
  const pinnedBuilder = (config.builder ?? PM_ZERO_BYTES32).toLowerCase();
  if (metadata !== PM_ZERO_BYTES32 && metadata !== pinnedMeta) reject('metadata is not zero or the pinned value');
  if (builder !== PM_ZERO_BYTES32 && builder !== pinnedBuilder) reject('builder is not zero or the pinned value');
  if (order.orderType !== 'FOK') reject('orderType must be FOK');

  const tokenId = uint256(value.tokenId, 'tokenId');
  if (tokenId !== BigInt(order.tokenId)) reject('tokenId does not match the intent');
  const market = (config.markets ?? []).find((entry) => BigInt(entry.tokenId) === tokenId);
  if (!market) reject('tokenId is not an allowlisted market');
  if (market.conditionId.toLowerCase() !== order.conditionId.toLowerCase()) reject('conditionId does not match the allowlisted market');
  if (market.negRisk !== order.negRisk) reject('negRisk does not match the allowlisted market');

  const makerAmount = uint256(value.makerAmount, 'makerAmount');
  const takerAmount = uint256(value.takerAmount, 'takerAmount');
  if (makerAmount <= 0n || takerAmount <= 0n) reject('order amounts must be positive');
  const shares = sideName === 'BUY' ? takerAmount : makerAmount;
  const notional = sideName === 'BUY' ? makerAmount : takerAmount;
  if (shares !== BigInt(order.size)) reject('size does not match the order amounts');
  if (notional !== priceMicros(order.notionalUsd, 'notionalUsd')) reject('notionalUsd does not match the collateral amount');
  // BUY price = collateral/shares. SELL price = collateral/shares. Both are 6-decimal ratios.
  const decoded = (notional * 1_000_000n) / shares;
  const limit = priceMicros(order.limitPrice, 'limitPrice');
  if (decoded !== limit) reject('limitPrice does not match the order amounts');
  const mid = priceMicros(order.mid, 'mid');
  const band = BigInt(Math.round((config.priceBand ?? 0.02) * 1_000_000));
  const delta = decoded > mid ? decoded - mid : mid - decoded;
  if (delta > band) reject('limit price is outside the mid band');

  const timestamp = uint256(value.timestamp, 'timestamp');
  const skew = timestamp > BigInt(args.now) ? timestamp - BigInt(args.now) : BigInt(args.now) - timestamp;
  if (skew > BigInt(PM_TIMESTAMP_SKEW_MS)) reject('order timestamp is outside ±120s');

  const salt = uint256(value.salt, 'salt').toString();
  if (args.state.hasSalt(salt)) reject('order salt was already used');
  if (args.state.hasHash(args.orderHash)) reject('order hash was already signed');
  const dayStart = Date.UTC(new Date(args.now).getUTCFullYear(), new Date(args.now).getUTCMonth(), new Date(args.now).getUTCDate());
  if (args.state.countSince(dayStart) >= (config.maxOrdersPerDay ?? 0)) reject('per-day order count limit is reached');
  if (config.maxOrderUsd !== undefined && notional > priceMicros(config.maxOrderUsd, 'maxOrderUsd')) {
    reject('order exceeds maxOrderUsd');
  }
  if (config.maxDailyUsd !== undefined) {
    const cap = priceMicros(config.maxDailyUsd, 'maxDailyUsd');
    if (args.state.spentSince(dayStart) + notional > cap) reject('order exceeds the daily USD ceiling');
  }

  if (sideName === 'SELL') {
    if (order.balance === undefined) reject('SELL requires the verifier balance');
    if (shares > BigInt(order.balance)) reject('SELL size exceeds the verifier balance');
  }

  const nav = priceMicros(order.navUsd, 'navUsd');
  if (nav <= 0n) reject('navUsd must be positive');
  const perOrder = effectivePct(config.perOrderPctNav ?? 0, order.perOrderPctNav, 'perOrderPctNav');
  if (!pctHolds(notional, nav, perOrder)) reject('order exceeds the per-order NAV cap');
  if (sideName === 'BUY') {
    const marketOpen = priceMicros(order.marketOpenUsd, 'marketOpenUsd') + notional;
    const totalOpen = priceMicros(order.totalOpenUsd, 'totalOpenUsd') + notional;
    const perMarket = effectivePct(config.perMarketPctNav ?? 0, order.perMarketPctNav, 'perMarketPctNav');
    const total = effectivePct(config.totalOpenPctNav ?? 0, order.totalOpenPctNav, 'totalOpenPctNav');
    if (!pctHolds(marketOpen, nav, perMarket)) reject('order exceeds the per-market NAV cap');
    if (!pctHolds(totalOpen, nav, total)) reject('order exceeds the total-open NAV cap');
  }
}

function addressField(value: unknown, label: string): string {
  try {
    return getAddress(String(value));
  } catch {
    reject(`${label} is not an address`);
  }
}

function wordField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isBytes32(value)) reject(`${label} must be bytes32`);
  return value.toLowerCase();
}

export function assertClobAuth(args: {
  config: PolymarketModuleConfig | undefined;
  typed: TypedDataPayload;
  wallet: string;
  now: number;
  orderHash: string;
  state: PolymarketReplayState;
}): void {
  if (!moduleEnabled(args.config) || args.config?.clobAuth !== true) {
    reject('clob-auth is denied unless the Polymarket module enables it');
  }
  const domain = args.typed.domain ?? {};
  const keys = domainKeys(domain).sort();
  if (keys.join(',') !== 'chainId,name,version') reject('ClobAuth domain fields do not match');
  if (domain.name !== PM_CLOB_AUTH_DOMAIN) reject('ClobAuth domain name does not match');
  if (String(domain.version) !== PM_CLOB_AUTH_VERSION) reject('ClobAuth domain version does not match');
  if (Number(domain.chainId) !== PM_CHAIN_ID) reject('ClobAuth domain chainId is not 137');
  const types = args.typed.types ?? {};
  const typeNames = Object.keys(types).filter((name) => name !== 'EIP712Domain');
  if (typeNames.length !== 1 || typeNames[0] !== 'ClobAuth' || !sameFields(types.ClobAuth, PM_CLOB_AUTH_FIELDS)) {
    reject('ClobAuth type schema does not match');
  }
  const value = args.typed.value ?? {};
  if (addressField(value.address, 'address') !== getAddress(args.wallet)) reject('clob-auth address is not the treasury');
  if (uint256(value.nonce, 'nonce') !== 0n) reject('clob-auth nonce must be 0');
  if (value.message !== PM_CLOB_AUTH_MESSAGE) reject('clob-auth message does not match');
  if (typeof value.timestamp !== 'string' || !DECIMAL.test(value.timestamp)) reject('clob-auth timestamp must be a decimal string');
  const stamp = BigInt(value.timestamp);
  const nowSec = BigInt(Math.floor(args.now / 1000));
  const skew = stamp > nowSec ? stamp - nowSec : nowSec - stamp;
  if (skew > 120n) reject('clob-auth timestamp is outside ±120s');
  if (args.state.hasHash(args.orderHash)) reject('clob-auth approval was already used');
}

export interface DecodedPolymarketTx {
  op: 'set-approval' | 'redeem' | 'revoke' | 'pause-user';
}

/** Gated Polygon calls. Anything else to a denied contract fails closed. */
export function decodePolymarketTransaction(to: string, data: string, config: PolymarketModuleConfig | undefined): DecodedPolymarketTx {
  if (!moduleEnabled(config)) reject('Polymarket is denied and cannot be enabled by config');
  const target = getAddress(to);
  const selector = selectorOf(data);
  if (target === CTF_ADDRESS) {
    if (selector === CTF.getFunction('splitPosition')!.selector || selector === CTF.getFunction('mergePositions')!.selector) {
      reject('CTF split and merge are denied');
    }
    if (selector === CTF.getFunction('setApprovalForAll')!.selector) {
      const decoded = decodeExact(CTF, 'setApprovalForAll', data);
      const operator = getAddress(String(decoded[0]));
      if (decoded[1] !== true && decoded[1] !== false) reject('setApprovalForAll must be true or false');
      if (config?.buyOnly === true && decoded[1] === true) reject('buyOnly denies setApprovalForAll(operator, true)');
      const v2 = operator === V2_STANDARD || operator === V2_NEG_RISK;
      const v1 = operator === V1_STANDARD || operator === V1_NEG_RISK;
      if (v2) return { op: decoded[1] === true ? 'set-approval' : 'revoke' };
      if (config?.revokeV1Ctf === true && v1 && decoded[1] === false) return { op: 'revoke' };
      if (v1 && decoded[1] === true) reject('setApprovalForAll(operator, true) is denied');
      reject('setApprovalForAll operator is not a current exchange');
    }
    if (selector === CTF.getFunction('redeemPositions')!.selector) {
      const decoded = decodeExact(CTF, 'redeemPositions', data);
      const collateral = getAddress(String(decoded[0]));
      if (!COLLATERAL.has(collateral)) reject('redeemPositions collateral is not USDC.e or pUSD');
      if (String(decoded[1]).toLowerCase() !== PM_ZERO_BYTES32) reject('redeemPositions parentCollectionId must be zero');
      const indexSets = [...(decoded[3] as bigint[])];
      if (indexSets.length === 0) reject('redeemPositions indexSets are empty');
      return { op: 'redeem' };
    }
  }
  if (target === ADAPTER && selector === NEG_RISK.getFunction('redeemPositions')!.selector) {
    const decoded = decodeExact(NEG_RISK, 'redeemPositions', data);
    const amounts = [...(decoded[1] as bigint[])];
    if (amounts.length === 0) reject('NegRiskAdapter redeemPositions amounts are empty');
    return { op: 'redeem' };
  }
  if ((target === PUSD || target === USDC_E) && selector === ERC20.getFunction('approve')!.selector) {
    const decoded = decodeExact(ERC20, 'approve', data);
    const spender = getAddress(String(decoded[0]));
    if (!DENIED.has(spender)) reject('ERC-20 approvals to Polymarket are denied');
    if (asBigInt(decoded[1]) !== 0n) reject('ERC-20 approvals to Polymarket are denied');
    return { op: 'revoke' };
  }
  if ((target === V2_STANDARD || target === V2_NEG_RISK) && selector === EXCHANGE.getFunction('pauseUser')!.selector) {
    decodeExact(EXCHANGE, 'pauseUser', data);
    return { op: 'pause-user' };
  }
  reject(`Contract ${target} is a built-in Polymarket denial`);
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string') return BigInt(value);
  reject('Polymarket amount could not be decoded');
}

function decodeExact(iface: Interface, name: string, data: string): ReadonlyArray<unknown> {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = iface.decodeFunctionData(name, data);
  } catch {
    reject(`Polymarket calldata for ${name} could not be decoded`);
  }
  const again = iface.encodeFunctionData(name, decoded);
  if (again.toLowerCase() !== data.toLowerCase()) reject('Polymarket calldata has trailing bytes');
  return decoded;
}

/** True when an ERC-20 approve spender is a Polymarket protocol contract. */
export function polymarketSpenderDenied(spender: string, amount: bigint, config: PolymarketModuleConfig | undefined): string | null {
  if (!isPolymarketDeniedAddress(spender)) return null;
  if (amount === 0n && moduleEnabled(config)) return null;
  if (amount === 0n) return 'Polymarket is denied and cannot be enabled by config';
  return 'ERC-20 approvals to Polymarket are denied';
}
