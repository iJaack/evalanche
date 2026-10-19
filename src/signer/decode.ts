/**
 * Decodes the calldata the reference signer is willing to sign.
 *
 * Unknown selectors are not signed. Benqi sAVAX instant unstake and the
 * Polymarket contracts are denied here and cannot be re-enabled by config.
 */

import { Interface, MaxUint256, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { decodeClmmCalldata, isClmmNpmApprove, isClmmPositionManager, type ClmmModuleConfig } from './clmm';
import { decodeDexCalldata, isDexRouter, type DexVenueConfig } from './dex-venue';
import type { SigningIntent } from './intent';
import { decodePolymarketTransaction, isPolymarketCollateral, isPolymarketCollateralApprove, isPolymarketDeniedAddress, polymarketSpenderDenied, type PolymarketModuleConfig } from './polymarket-module';
import { takeCctp, type CctpConfig } from './cctp';
import { isKnownRevokeToken, takeRevokeOnly, type RevokeOnlyConfig } from './revoke-only';
import { POLYMARKET_DENY_CONTRACTS as POLYMARKET_DENY_LIST } from './polymarket-addresses';

export const SAVAX_CONTRACT = '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE';
export const REDEEM_INSTANT_SELECTOR = '0xfbc3b807';
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Li.Fi's native-asset sentinel. Treated as the zero address for value and caps. */
export const LIFI_NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
/**
 * Li.Fi diamond. The same address is deployed on Avalanche C-Chain.
 * `facets()` there does not register `swapTokensGeneric` (`0x4630a0d8`).
 */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
/**
 * GenericSwapFacetV3, from Avalanche `facets()` on {@link LIFI_DIAMOND}.
 * It serves the ERC-20 V3 selectors. Native V3 selectors stay undecoded.
 */
export const LIFI_GENERIC_SWAP_FACET_V3 = '0x31a9b1835864706Af10103b31Ea2b79bdb995F5F';
/**
 * KyberSwap MetaAggregationRouterV2. Production lists it as `dex` and `spender`
 * with no selectors. `swap` (`0xe21fd0e9`) is decoded only as the inner
 * calldata of a Li.Fi V3 leg, not as a transaction the signer will call directly.
 */
export const KYBER_META_AGGREGATION_ROUTER_V2 = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
/** MetaAggregationRouterV2 `swap`. Every other selector on this router is denied. */
export const KYBER_SWAP_SELECTOR = '0xe21fd0e9';
/**
 * Kyber AggregationExecutorProxy on Avalanche. `callTarget` must be this
 * address unless config replaces `kyberExecutors`. Real quotes send the
 * input to a pool named inside that executor's calldata, not to the proxy.
 */
export const KYBER_AGGREGATION_EXECUTOR = '0x8F10B468b06c6FD214B65F87778827F7D113f996';

/**
 * Polymarket protocol contracts. Config cannot put these back on the allowlist.
 * The Polymarket module, when enabled, may still sign the gated calls.
 */
export const POLYMARKET_DENY_CONTRACTS = POLYMARKET_DENY_LIST;

const ERC20 = new Interface([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

const ERC4626 = new Interface([
  'function deposit(uint256 assets, address receiver)',
  'function redeem(uint256 shares, address receiver, address owner)',
]);

const SAVAX = new Interface([
  'function submit()',
  'function requestRedeem(uint256 shareAmount)',
  'function redeemInstant(uint256 shareAmount, uint256 minAvaxOut)',
]);

const SWAP_LEG = 'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';

const LIFI = new Interface([
  `function swapTokensGeneric(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmount, ${SWAP_LEG}[] swapData)`,
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_LEG}[] swapData)`,
  'function multicall(bytes[] data)',
]);

const KYBER = new Interface([
  'function swap((address callTarget, address approveTarget, bytes targetData, (address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes clientData) execution) payable returns (uint256 returnAmount, uint256 gasUsed)',
]);

const PERMIT2 = new Interface([
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
]);

export const SELECTOR = {
  transfer: '0xa9059cbb',
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
  erc2612Permit: '0xd505accf',
  permit2: '0x2b67b570',
  deposit: '0x6e553f65',
  redeem: '0xba087652',
  submit: '0x5bcb2fc6',
  requestRedeem: '0xaa2f892d',
  redeemInstant: REDEEM_INSTANT_SELECTOR,
  swapTokensGeneric: '0x4630a0d8',
  /** GenericSwapFacetV3 `swapTokensSingleV3ERC20ToERC20`. One SwapData struct, not an array. */
  swapTokensSingleV3ERC20ToERC20: '0x4666fc80',
  /** GenericSwapFacetV3 `swapTokensMultipleV3ERC20ToERC20`. */
  swapTokensMultipleV3ERC20ToERC20: '0x5fd9ae2e',
  multicall: '0xac9650d8',
  native: '0x',
} as const;

export function isLifiV3Selector(selector: string): boolean {
  return selector === SELECTOR.swapTokensSingleV3ERC20ToERC20
    || selector === SELECTOR.swapTokensMultipleV3ERC20ToERC20;
}

export type DecodedKind =
  | 'native-transfer'
  | 'erc20-transfer'
  | 'erc20-approve'
  | 'erc20-increase-allowance'
  | 'erc2612-permit'
  | 'permit2'
  | 'erc4626-deposit'
  | 'erc4626-redeem'
  | 'savax-submit'
  | 'savax-request-redeem'
  | 'lifi-swap'
  | 'polymarket-call'
  | 'clmm-call'
  | 'dex-swap'
  | 'cctp-burn'
  | 'cctp-mint';

export interface DecodedCall {
  kind: DecodedKind;
  selector: string;
  /** Raw token or share amount taken from calldata, or native value for submit. */
  amount?: bigint;
  minOut?: bigint;
  /** Protocol receiver that must equal the signer wallet. A Li.Fi V3 receiver must also carry the recipient role. Absent for ERC-20 transfer. */
  receiver?: string;
  owner?: string;
  spender?: string;
  /** ERC-20 transfer recipient. Must be on the chain allow map. */
  recipient?: string;
  /**
   * Asset whose amount is capped and priced. Native value uses the zero address.
   * Absent when a vault deposit has no configured underlying.
   */
  asset?: string;
  /** Present for a gated Polymarket or CLMM call. Generic amount checks skip these. */
  moduleOp?: string;
}

export interface DecodeOptions {
  wallet: string;
  value: bigint;
  explicitAllows: ReadonlySet<string>;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
  /** True when the address is on this chain's allow map. */
  allowAddress: (address: string) => boolean;
  /** True when `selector` may be invoked on `to`. */
  allowSelector: (to: string, selector: string) => boolean;
  /** ERC-4626 underlying configured for a vault, if any. */
  underlyingOf?: (vault: string) => string | undefined;
  /** True when `address` carries `role` on this chain's allow map. */
  allowRole: (address: string, role: AllowRole) => boolean;
  /**
   * Allowed Kyber `callTarget` addresses. Defaults to the Avalanche
   * AggregationExecutorProxy. An empty list allows none.
   */
  kyberExecutors?: readonly string[];
  /** Li.Fi diamond used for Kyber destination checks. Defaults to the canonical diamond. */
  lifiDiamond?: string;
  polymarket?: PolymarketModuleConfig;
  /** Zero approvals. Off unless `enabled` is true. */
  revokeOnly?: RevokeOnlyConfig;
  /** CCTP V2 burn and receive. Off unless `enabled` is true. */
  cctp?: CctpConfig;
  clmm?: ClmmModuleConfig;
  /** Chain of this call. Set by the signer so a pinned DEX router is decoded. */
  chainId?: number;
  /** Direct swap venue for `chainId`. Absent or disabled denies that router. */
  dex?: DexVenueConfig;
  /** Unix seconds. CLMM and DEX deadlines are checked against this clock. */
  nowSec?: number;
  intent?: SigningIntent;
}

export type AllowRole = 'dex' | 'spender' | 'recipient' | 'token' | 'vault';

const HARD_DENIED_CONTRACTS = new Set(POLYMARKET_DENY_CONTRACTS.map((address) => getAddress(address)));
const SAVAX_ADDRESS = getAddress(SAVAX_CONTRACT);

export function isHardDeniedContract(address: string): boolean {
  try {
    return HARD_DENIED_CONTRACTS.has(getAddress(address));
  } catch {
    return false;
  }
}

export function isSavaxInstantUnstake(address: string, data: string): boolean {
  try {
    return getAddress(address) === SAVAX_ADDRESS && selectorOf(data) === REDEEM_INSTANT_SELECTOR;
  } catch {
    return false;
  }
}

export function isNativeAsset(address: string): boolean {
  try {
    const checksum = getAddress(address);
    return checksum === NATIVE_ADDRESS || checksum === getAddress(LIFI_NATIVE_SENTINEL);
  } catch {
    return false;
  }
}

/** Price and cap native under the zero address, whichever sentinel the calldata used. */
export function canonicalAsset(address: string): string {
  return isNativeAsset(address) ? NATIVE_ADDRESS : getAddress(address);
}

function requireRole(options: DecodeOptions, address: string, role: AllowRole, label: string): void {
  if (!options.allowRole(address, role)) fail(`${label} is not an allowlisted ${role}`);
}

function sameAsset(left: string, right: string): boolean {
  if (isNativeAsset(left) && isNativeAsset(right)) return true;
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

export function selectorOf(data: string | undefined): string {
  const normalized = (data ?? '0x').toLowerCase();
  if (normalized === '0x' || normalized === '') return '0x';
  if (!/^0x[0-9a-f]*$/.test(normalized) || normalized.length < 10) return normalized.slice(0, 10);
  return normalized.slice(0, 10);
}

export function decodeCalldata(to: string, data: string, options: DecodeOptions, depth = 0): DecodedCall[] {
  if (depth > 2) fail('Nested multicall is too deep to decode');
  const selector = selectorOf(data);
  if (isClmmPositionManager(to) || (options.clmm?.enabled && isClmmNpmApprove(to, data))) {
    const calls = decodeClmmCalldata(to, data, options.clmm, options.wallet, options.value, options.nowSec ?? Math.floor(Date.now() / 1000), options.intent, depth);
    return calls.map((call) => ({
      kind: 'clmm-call' as const,
      selector,
      amount: call.op === 'approve' ? call.amount : undefined,
      asset: call.token,
      moduleOp: call.op,
      receiver: call.recipient,
    }));
  }
  if (isHardDeniedContract(to)) {
    if (!options.polymarket?.enabled) fail(`Contract ${getAddress(to)} is a built-in Polymarket denial`);
    const gated = decodePolymarketTransaction(to, data, options.polymarket);
    return [{ kind: 'polymarket-call', selector, moduleOp: gated.op }];
  }
  if (isSavaxInstantUnstake(to, data)) {
    fail('Benqi sAVAX instant unstake (redeemInstant) is denied and cannot be enabled by config');
  }
  const cctp = takeCctp({
    chainId: options.chainId,
    to,
    data,
    value: options.value,
    config: options.cctp,
    wallet: options.wallet,
  });
  if (cctp) return [cctp];
  const revoke = takeRevokeOnly({
    to,
    data,
    value: options.value,
    enabled: options.revokeOnly?.enabled === true,
    inScope: (options.chainId !== undefined && isKnownRevokeToken(options.chainId, to))
      || options.allowAddress(to)
      || options.allowRole(to, 'token'),
    spenderAllowed: (() => {
      try {
        const decoded = ERC20.decodeFunctionData('approve', data);
        return options.allowRole(getAddress(String(decoded[0])), 'spender');
      } catch {
        return false;
      }
    })(),
  });
  if (revoke) return [revoke];
  if (selector === SELECTOR.increaseAllowance && !options.explicitAllows.has('increaseAllowance')) {
    fail('increaseAllowance is denied unless explicitly allowed');
  }
  if ((selector === SELECTOR.erc2612Permit || selector === SELECTOR.permit2)
    && !options.explicitAllows.has(selector === SELECTOR.permit2 ? 'permit2' : 'permit')) {
    fail('Permit calldata is denied unless explicitly allowed');
  }

  if (isPolymarketCollateralApprove(to, data) && isPolymarketCollateral(to)) {
    const gated = decodePolymarketTransaction(to, data, options.polymarket);
    return [{ kind: 'polymarket-call', selector, moduleOp: gated.op }];
  }

  if (options.chainId !== undefined && isDexRouter(options.chainId, to)) {
    const swaps = decodeDexCalldata(to, data, {
      chainId: options.chainId,
      config: options.dex,
      wallet: options.wallet,
      value: options.value,
      tokenIn: options.tokenIn,
      tokenOut: options.tokenOut,
      amountIn: options.amountIn,
      allowRole: (address) => options.allowRole(address, 'token'),
      nowSec: options.nowSec ?? Math.floor(Date.now() / 1000),
    }, depth);
    return swaps.map((swap) => ({
      kind: 'dex-swap' as const,
      selector: swap.selector,
      amount: swap.amountIn,
      minOut: swap.minOut,
      receiver: swap.recipient,
      asset: swap.tokenIn,
    }));
  }

  if (!options.allowSelector(to, selector)) {
    fail(`Function selector ${selector} is not allowlisted`);
  }
  if (selector === '0x') {
    let recipient: string;
    try {
      recipient = getAddress(to);
    } catch {
      fail('native transfer recipient is not allowlisted');
    }
    requireRole(options, recipient, 'recipient', 'native transfer recipient');
    return [{ kind: 'native-transfer', selector, amount: options.value, asset: NATIVE_ADDRESS, recipient }];
  }
  if (selector === SELECTOR.multicall) {
    let decoded: ReturnType<Interface['decodeFunctionData']>;
    try {
      decoded = LIFI.decodeFunctionData('multicall', data);
    } catch {
      fail('Li.Fi multicall calldata could not be decoded');
    }
    const inners = decoded[0] as string[];
    if (!Array.isArray(inners) || inners.length === 0) fail('Li.Fi multicall has no inner calls');
    return inners.flatMap((inner) => decodeCalldata(to, inner, options, depth + 1));
  }
  return [decodeOne(to, data, selector, options)];
}

function decodeOne(to: string, data: string, selector: string, options: DecodeOptions): DecodedCall {
  try {
    switch (selector) {
      case SELECTOR.transfer: {
        const decoded = ERC20.decodeFunctionData('transfer', data);
        const recipient = getAddress(String(decoded[0]));
        if (!options.allowRole(recipient, 'recipient')) fail('ERC-20 transfer recipient is not allowlisted');
        requireRole(options, getAddress(to), 'token', 'token contract');
        return { kind: 'erc20-transfer', selector, amount: BigInt(decoded[1]), recipient, asset: getAddress(to) };
      }
      case SELECTOR.approve: {
        const decoded = ERC20.decodeFunctionData('approve', data);
        const amount = BigInt(decoded[1]);
        // Zero is a reset after a failed swap. Approve and the swap are separate
        // transactions, so this path does not require a paired swap and does not
        // reject a spender that also has the dex role. Roles are additive.
        if (amount === MaxUint256) fail('Unlimited ERC-20 approval is denied');
        const spender = getAddress(String(decoded[0]));
        const polymarketDenial = polymarketSpenderDenied(spender, amount, options.polymarket);
        if (polymarketDenial) fail(polymarketDenial);
        if (polymarketDenial === null && isPolymarketDeniedAddress(spender)) {
          return { kind: 'erc20-approve', selector, amount, spender, asset: getAddress(to) };
        }
        if (!options.allowRole(spender, 'spender')) fail('approve spender is not allowlisted');
        requireRole(options, getAddress(to), 'token', 'token contract');
        return { kind: 'erc20-approve', selector, amount, spender, asset: getAddress(to) };
      }
      case SELECTOR.increaseAllowance: {
        const decoded = ERC20.decodeFunctionData('increaseAllowance', data);
        const amount = BigInt(decoded[1]);
        if (amount === MaxUint256) fail('Unlimited ERC-20 increaseAllowance is denied');
        const spender = getAddress(String(decoded[0]));
        if (!options.allowRole(spender, 'spender')) fail('increaseAllowance spender is not allowlisted');
        requireRole(options, getAddress(to), 'token', 'token contract');
        return { kind: 'erc20-increase-allowance', selector, amount, spender, asset: getAddress(to) };
      }
      case SELECTOR.erc2612Permit: {
        const decoded = ERC20.decodeFunctionData('permit', data);
        const owner = getAddress(String(decoded[0]));
        if (owner !== options.wallet) fail('Permit owner is not the signer wallet');
        const amount = BigInt(decoded[2]);
        if (amount === MaxUint256) fail('Unlimited ERC-20 permit is denied');
        const spender = getAddress(String(decoded[1]));
        if (!options.allowRole(spender, 'spender')) fail('Permit spender is not allowlisted');
        requireRole(options, getAddress(to), 'token', 'token contract');
        return { kind: 'erc2612-permit', selector, amount, receiver: owner, spender, asset: getAddress(to) };
      }
      case SELECTOR.permit2: {
        const decoded = PERMIT2.decodeFunctionData('permit', data);
        const owner = getAddress(String(decoded[0]));
        if (owner !== options.wallet) fail('Permit2 owner is not the signer wallet');
        const details = decoded[1].details;
        const amount = BigInt(details.amount);
        if (amount === MaxUint256 || amount >= (1n << 160n) - 1n) fail('Unlimited Permit2 allowance is denied');
        const spender = getAddress(String(decoded[1].spender));
        if (!options.allowRole(spender, 'spender')) fail('Permit2 spender is not allowlisted');
        const permitToken = canonicalAsset(String(details.token));
        if (!isNativeAsset(permitToken)) requireRole(options, permitToken, 'token', 'permit token');
        return { kind: 'permit2', selector, amount, receiver: owner, spender, asset: canonicalAsset(String(details.token)) };
      }
      case SELECTOR.deposit: {
        const decoded = ERC4626.decodeFunctionData('deposit', data);
        requireRole(options, getAddress(to), 'vault', 'vault');
        const underlying = options.underlyingOf?.(to);
        if (underlying && !isNativeAsset(underlying)) requireRole(options, canonicalAsset(underlying), 'token', 'vault underlying');
        return {
          kind: 'erc4626-deposit',
          selector,
          amount: BigInt(decoded[0]),
          receiver: getAddress(String(decoded[1])),
          asset: underlying ? canonicalAsset(underlying) : undefined,
        };
      }
      case SELECTOR.redeem: {
        const decoded = ERC4626.decodeFunctionData('redeem', data);
        requireRole(options, getAddress(to), 'vault', 'vault');
        return {
          kind: 'erc4626-redeem',
          selector,
          amount: BigInt(decoded[0]),
          receiver: getAddress(String(decoded[1])),
          owner: getAddress(String(decoded[2])),
          asset: getAddress(to),
        };
      }
      case SELECTOR.submit: {
        SAVAX.decodeFunctionData('submit', data);
        requireRole(options, getAddress(to), 'vault', 'vault');
        if (getAddress(to) !== SAVAX_ADDRESS) fail('submit() is only decoded for Benqi sAVAX');
        return { kind: 'savax-submit', selector, amount: options.value, receiver: options.wallet, asset: NATIVE_ADDRESS };
      }
      case SELECTOR.requestRedeem: {
        requireRole(options, getAddress(to), 'vault', 'vault');
        if (getAddress(to) !== SAVAX_ADDRESS) fail('requestRedeem is only decoded for Benqi sAVAX');
        const decoded = SAVAX.decodeFunctionData('requestRedeem', data);
        return { kind: 'savax-request-redeem', selector, amount: BigInt(decoded[0]), receiver: options.wallet, asset: SAVAX_ADDRESS };
      }
      case SELECTOR.swapTokensGeneric:
      case SELECTOR.swapTokensSingleV3ERC20ToERC20:
      case SELECTOR.swapTokensMultipleV3ERC20ToERC20: {
        return decodeSwap(to, data, selector, options);
      }
      default:
        fail(`Unknown selector ${selector} cannot be decoded and is denied`);
    }
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    fail(`Calldata for ${selector} could not be decoded`);
  }
}

interface SwapLeg {
  callTo: string;
  approveTo: string;
  sendingAsset: string;
  receivingAsset: string;
  fromAmount: bigint;
  callData: string;
  requiresDeposit: boolean;
}

function lifiSwapFunction(selector: string): string {
  switch (selector) {
    case SELECTOR.swapTokensGeneric:
      return 'swapTokensGeneric';
    case SELECTOR.swapTokensSingleV3ERC20ToERC20:
      return 'swapTokensSingleV3ERC20ToERC20';
    case SELECTOR.swapTokensMultipleV3ERC20ToERC20:
      return 'swapTokensMultipleV3ERC20ToERC20';
    default:
      fail(`Unknown selector ${selector} cannot be decoded and is denied`);
  }
}

function decodeSwap(to: string, data: string, selector: string, options: DecodeOptions): DecodedCall {
  void to;
  const decoded = LIFI.decodeFunctionData(lifiSwapFunction(selector), data);
  const v3 = isLifiV3Selector(selector);
  if (v3) {
    const again = LIFI.encodeFunctionData(lifiSwapFunction(selector), decoded);
    if (again.toLowerCase() !== data.toLowerCase()) fail('Li.Fi V3 calldata has trailing bytes');
  }
  const receiver = getAddress(String(decoded[3]));
  const minOut = BigInt(decoded[4]);
  if (v3 && minOut === 0n) fail('Li.Fi V3 minAmountOut must be greater than zero');
  // A single SwapData struct is array-like (one slot per field). Branch on the
  // selector; do not use Array.isArray to tell a struct from a leg array.
  const swaps = (selector === SELECTOR.swapTokensSingleV3ERC20ToERC20 ? [decoded[5]] : decoded[5]) as Array<{
    callTo: string;
    approveTo: string;
    sendingAssetId: string;
    receivingAssetId: string;
    fromAmount: bigint;
    callData: string;
    requiresDeposit: boolean;
  }>;
  if (!swaps || swaps.length === 0) fail('Li.Fi swap has no swap legs');
  if (v3) requireRole(options, receiver, 'recipient', 'Li.Fi receiver');
  const legs: SwapLeg[] = swaps.map((swap) => ({
    callTo: getAddress(String(swap.callTo)),
    approveTo: getAddress(String(swap.approveTo)),
    sendingAsset: String(swap.sendingAssetId),
    receivingAsset: String(swap.receivingAssetId),
    fromAmount: BigInt(swap.fromAmount),
    callData: swap.callData === undefined || swap.callData === null ? '0x' : String(swap.callData),
    requiresDeposit: Boolean(swap.requiresDeposit),
  }));
  if (!options.tokenIn) fail('Li.Fi swap requires tokenIn');
  if (!options.tokenOut) fail('Li.Fi swap requires tokenOut');
  if (options.amountIn === undefined) fail('Li.Fi swap requires amountIn');
  const first = legs[0];
  if (!sameAsset(first.sendingAsset, options.tokenIn)) {
    fail('leg sendingAsset does not match tokenIn');
  }
  if (first.fromAmount !== options.amountIn) fail('leg fromAmount does not match amountIn');
  for (let i = 0; i < legs.length - 1; i += 1) {
    if (!sameAsset(legs[i].receivingAsset, legs[i + 1].sendingAsset)) {
      fail('swap leg receivingAsset does not match the next sendingAsset');
    }
  }
  const last = legs[legs.length - 1];
  if (!sameAsset(last.receivingAsset, options.tokenOut)) {
    fail('last leg receivingAsset does not match tokenOut');
  }
  if (first.requiresDeposit !== true) fail('first swap leg must set requiresDeposit');
  for (let i = 1; i < legs.length; i += 1) {
    if (legs[i].requiresDeposit !== false) fail('later swap legs must not set requiresDeposit');
  }
  for (const leg of legs) {
    if (options.allowRole(leg.callTo, 'token')) fail('token address cannot be callTo');
    if (!options.allowRole(leg.callTo, 'dex')) fail('Li.Fi callTo is not allowlisted');
    if (!options.allowRole(leg.approveTo, 'spender')) fail('Li.Fi approveTo is not allowlisted');
    for (const asset of [leg.sendingAsset, leg.receivingAsset]) {
      if (isNativeAsset(asset)) continue;
      requireRole(options, canonicalAsset(asset), 'token', 'swap asset');
    }
  }
  if (v3) assertKyberLegs(legs, options);
  const native = isNativeAsset(first.sendingAsset);
  if (native) {
    if (options.value !== first.fromAmount) fail('native swap value must equal fromAmount');
  } else if (options.value !== 0n) {
    fail('token swap value must be 0');
  }
  return {
    kind: 'lifi-swap',
    selector,
    amount: first.fromAmount,
    minOut,
    receiver,
    asset: canonicalAsset(first.sendingAsset),
  };
}

/**
 * A V3 leg that calls the Kyber router must be `swap` (`0xe21fd0e9`) and
 * nothing else. `swapSimpleMode`, `swapGeneric`, empty calldata, and any
 * other selector are denied. The payload must re-encode to the same bytes.
 * `callTarget` must be an allowed executor. `srcReceivers` must be that
 * executor or a pool at a decoded position in its calldata, and their
 * amounts must sum to the swap amount. Fee receivers must be empty or carry
 * zero amounts.
 * Proceeds land on the diamond, or on an allowlisted recipient on the last hop.
 * A non-Kyber dex is not inner-decoded.
 */
function assertKyberLegs(legs: SwapLeg[], options: DecodeOptions): void {
  const diamond = getAddress(options.lifiDiamond ?? LIFI_DIAMOND);
  const router = getAddress(KYBER_META_AGGREGATION_ROUTER_V2);
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (getAddress(leg.callTo) !== router) continue;
    if (selectorOf(leg.callData) !== KYBER_SWAP_SELECTOR) {
      fail('Kyber router selector is not swap');
    }
    let decoded: ReturnType<Interface['decodeFunctionData']>;
    try {
      decoded = KYBER.decodeFunctionData('swap', leg.callData);
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      fail('Kyber swap calldata could not be decoded');
    }
    const execution = decoded[0];
    const again = KYBER.encodeFunctionData('swap', [execution]);
    if (again.toLowerCase() !== leg.callData.toLowerCase()) {
      fail('Kyber swap calldata has trailing bytes');
    }
    const desc = execution.desc as {
      srcToken: string;
      dstToken: string;
      srcReceivers: readonly string[];
      srcAmounts: readonly bigint[];
      feeReceivers: readonly string[];
      feeAmounts: readonly bigint[];
      dstReceiver: string;
      amount: bigint;
    };
    if (!sameAsset(String(desc.srcToken), leg.sendingAsset)) {
      fail('Kyber srcToken does not match the swap leg sending asset');
    }
    if (!sameAsset(String(desc.dstToken), leg.receivingAsset)) {
      fail('Kyber dstToken does not match the swap leg receiving asset');
    }
    assertKyberParties(execution as { callTarget: string; approveTarget: string; targetData: string }, desc, options);
    let dstReceiver: string;
    try {
      dstReceiver = getAddress(String(desc.dstReceiver));
    } catch {
      fail('Kyber dstReceiver is not an address');
    }
    const last = i === legs.length - 1;
    if (!last) {
      if (dstReceiver !== diamond) fail('Kyber dstReceiver on an intermediate leg must be the Li.Fi diamond');
      continue;
    }
    if (dstReceiver !== diamond && !options.allowRole(dstReceiver, 'recipient')) {
      fail('Kyber dstReceiver is not the Li.Fi diamond or an allowlisted recipient');
    }
  }
}

function kyberExecutorSet(options: DecodeOptions): Set<string> {
  const list = options.kyberExecutors ?? [KYBER_AGGREGATION_EXECUTOR];
  const set = new Set<string>();
  for (const entry of list) {
    try {
      set.add(getAddress(entry));
    } catch {
      fail('Kyber executor is not an address');
    }
  }
  return set;
}

function assertKyberParties(
  execution: { callTarget: string; approveTarget: string; targetData: string },
  desc: {
    srcReceivers: readonly string[];
    srcAmounts: readonly bigint[];
    feeReceivers: readonly string[];
    feeAmounts: readonly bigint[];
    amount: bigint;
  },
  options: DecodeOptions,
): void {
  const executors = kyberExecutorSet(options);
  const router = getAddress(KYBER_META_AGGREGATION_ROUTER_V2);
  const zero = getAddress(NATIVE_ADDRESS);
  let callTarget: string;
  let approveTarget: string;
  try {
    callTarget = getAddress(String(execution.callTarget));
    approveTarget = getAddress(String(execution.approveTarget));
  } catch {
    fail('Kyber callTarget is not an address');
  }
  if (!executors.has(callTarget)) fail('Kyber callTarget is not an allowed executor');
  if (approveTarget !== zero && approveTarget !== router && !executors.has(approveTarget)) {
    fail('Kyber approveTarget is not an allowed executor');
  }
  const srcReceivers = [...desc.srcReceivers];
  const srcAmounts = [...desc.srcAmounts].map((amount) => BigInt(amount));
  if (srcReceivers.length === 0 || srcReceivers.length !== srcAmounts.length) {
    fail('Kyber srcReceivers must name the executor or a pool in the executor calldata');
  }
  let sum = 0n;
  for (const amount of srcAmounts) sum += amount;
  if (sum !== BigInt(desc.amount)) fail('Kyber srcAmounts must sum to the swap amount');
  const pools = kyberDecodedPools(String(execution.targetData ?? '0x'));
  for (const receiver of srcReceivers) {
    let address: string;
    try {
      address = getAddress(String(receiver));
    } catch {
      fail('Kyber srcReceiver is not an address');
    }
    if (executors.has(address)) continue;
    if (!pools.has(address)) fail('Kyber srcReceiver is not an allowed executor');
  }
  const feeReceivers = [...desc.feeReceivers];
  const feeAmounts = [...desc.feeAmounts].map((amount) => BigInt(amount));
  if (feeReceivers.length !== feeAmounts.length) fail('Kyber feeReceivers and feeAmounts differ in length');
  for (const amount of feeAmounts) {
    if (amount !== 0n) fail('Kyber fee amount must be zero');
  }
}

/**
 * Pools named by the AggregationExecutor calldata. Each logical word stores a
 * uint160 in its first 20 bytes. A swap array is a count word, then that many
 * byte offsets, then fixed-size elements. The pool is the last word of each
 * element. Bytes after that array are not pools, and a match has to be that
 * whole word, not a substring at an arbitrary offset.
 */
function kyberDecodedPools(targetData: string): Set<string> {
  const hex = targetData.startsWith('0x') ? targetData.slice(2) : targetData;
  const bytes = hex.length >= 2 && hex.length % 2 === 0 ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  const words = Math.floor(bytes.length / 32);
  const wordAt = (index: number) => bytes.subarray(index * 32, index * 32 + 32);
  const high160 = (word: Buffer) => BigInt(`0x${word.subarray(0, 20).toString('hex')}`);
  const tailClear = (word: Buffer) => word.subarray(20).every((byte) => byte === 0);
  const pools = new Set<string>();
  let chosenEnd = bytes.length;
  for (let index = 0; index < words; index += 1) {
    const header = wordAt(index);
    const count = high160(header);
    if (!tailClear(header) || count < 1n || count > 8n) continue;
    const total = Number(count);
    if (index + 1 + total >= words) continue;
    const offsets: number[] = [];
    let shaped = true;
    for (let slot = 0; slot < total; slot += 1) {
      const offsetWord = wordAt(index + 1 + slot);
      const offset = high160(offsetWord);
      if (!tailClear(offsetWord) || offset === 0n || offset % 32n !== 0n) {
        shaped = false;
        break;
      }
      offsets.push(Number(offset));
    }
    if (!shaped) continue;
    for (let slot = 1; slot < offsets.length; slot += 1) {
      if (offsets[slot] <= offsets[slot - 1]) shaped = false;
    }
    if (!shaped) continue;
    const base = (index + 1) * 32;
    if (base >= chosenEnd) continue;
    const sizes: number[] = [];
    for (let slot = 1; slot < offsets.length; slot += 1) sizes.push(offsets[slot] - offsets[slot - 1]);
    const size = sizes[0] ?? 192;
    if (sizes.some((item) => item !== size) || size < 32 || size % 32 !== 0) continue;
    const found: string[] = [];
    let fit = true;
    for (const offset of offsets) {
      const start = base + offset;
      if (start < base || start + size > bytes.length) {
        fit = false;
        break;
      }
      const poolWord = bytes.subarray(start + size - 32, start + size);
      let address: string;
      try {
        address = getAddress(`0x${poolWord.subarray(0, 20).toString('hex')}`);
      } catch {
        fit = false;
        break;
      }
      if (address === getAddress(NATIVE_ADDRESS)) {
        fit = false;
        break;
      }
      found.push(address);
    }
    if (!fit || found.length !== total) continue;
    const end = base + offsets[offsets.length - 1] + size;
    if (end > chosenEnd) continue;
    for (const address of found) pools.add(address);
    chosenEnd = end;
  }
  return pools;
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}
