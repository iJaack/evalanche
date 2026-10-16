/**
 * Decodes the calldata the reference signer is willing to sign.
 *
 * Unknown selectors are not signed. Benqi sAVAX instant unstake and the
 * Polymarket contracts are denied here and cannot be re-enabled by config.
 */

import { Interface, MaxUint256, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const SAVAX_CONTRACT = '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE';
export const REDEEM_INSTANT_SELECTOR = '0xfbc3b807';
export const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Polymarket protocol contracts. Config cannot put these back on the allowlist. */
export const POLYMARKET_DENY_CONTRACTS = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  '0xe2222d279d744050d28e00520010520000310F59',
] as const;

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

const LIFI = new Interface([
  'function swapTokensGeneric(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmount, tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swapData)',
  'function multicall(bytes[] data)',
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
  multicall: '0xac9650d8',
  native: '0x',
} as const;

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
  | 'lifi-swap';

export interface DecodedCall {
  kind: DecodedKind;
  selector: string;
  /** Raw token or share amount taken from calldata, or native value for submit. */
  amount?: bigint;
  minOut?: bigint;
  /** Protocol receiver that must equal the signer wallet. Absent for ERC-20 transfer. */
  receiver?: string;
  owner?: string;
  spender?: string;
}

export interface DecodeOptions {
  wallet: string;
  value: bigint;
  explicitAllows: ReadonlySet<string>;
}

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

export function selectorOf(data: string | undefined): string {
  const normalized = (data ?? '0x').toLowerCase();
  if (normalized === '0x' || normalized === '') return '0x';
  if (!/^0x[0-9a-f]*$/.test(normalized) || normalized.length < 10) return normalized.slice(0, 10);
  return normalized.slice(0, 10);
}

export function decodeCalldata(to: string, data: string, options: DecodeOptions, depth = 0): DecodedCall[] {
  if (depth > 2) fail('Nested multicall is too deep to decode');
  const selector = selectorOf(data);
  if (isHardDeniedContract(to)) fail(`Contract ${getAddress(to)} is a built-in Polymarket denial`);
  if (isSavaxInstantUnstake(to, data)) {
    fail('Benqi sAVAX instant unstake (redeemInstant) is denied and cannot be enabled by config');
  }
  if (selector === SELECTOR.increaseAllowance && !options.explicitAllows.has('increaseAllowance')) {
    fail('increaseAllowance is denied unless explicitly allowed');
  }
  if ((selector === SELECTOR.erc2612Permit || selector === SELECTOR.permit2)
    && !options.explicitAllows.has(selector === SELECTOR.permit2 ? 'permit2' : 'permit')) {
    fail('Permit calldata is denied unless explicitly allowed');
  }

  if (selector === '0x') {
    return [{ kind: 'native-transfer', selector, amount: options.value }];
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
        return { kind: 'erc20-transfer', selector, amount: BigInt(decoded[1]) };
      }
      case SELECTOR.approve: {
        const decoded = ERC20.decodeFunctionData('approve', data);
        const amount = BigInt(decoded[1]);
        if (amount === MaxUint256) fail('Unlimited ERC-20 approval is denied');
        return { kind: 'erc20-approve', selector, amount, spender: getAddress(String(decoded[0])) };
      }
      case SELECTOR.increaseAllowance: {
        const decoded = ERC20.decodeFunctionData('increaseAllowance', data);
        const amount = BigInt(decoded[1]);
        if (amount === MaxUint256) fail('Unlimited ERC-20 increaseAllowance is denied');
        return { kind: 'erc20-increase-allowance', selector, amount, spender: getAddress(String(decoded[0])) };
      }
      case SELECTOR.erc2612Permit: {
        const decoded = ERC20.decodeFunctionData('permit', data);
        const owner = getAddress(String(decoded[0]));
        if (owner !== options.wallet) fail('Permit owner is not the signer wallet');
        const amount = BigInt(decoded[2]);
        if (amount === MaxUint256) fail('Unlimited ERC-20 permit is denied');
        return { kind: 'erc2612-permit', selector, amount, receiver: owner, spender: getAddress(String(decoded[1])) };
      }
      case SELECTOR.permit2: {
        const decoded = PERMIT2.decodeFunctionData('permit', data);
        const owner = getAddress(String(decoded[0]));
        if (owner !== options.wallet) fail('Permit2 owner is not the signer wallet');
        const details = decoded[1].details;
        const amount = BigInt(details.amount);
        if (amount === MaxUint256 || amount >= (1n << 160n) - 1n) fail('Unlimited Permit2 allowance is denied');
        return { kind: 'permit2', selector, amount, receiver: owner, spender: getAddress(String(decoded[1].spender)) };
      }
      case SELECTOR.deposit: {
        const decoded = ERC4626.decodeFunctionData('deposit', data);
        return {
          kind: 'erc4626-deposit',
          selector,
          amount: BigInt(decoded[0]),
          receiver: getAddress(String(decoded[1])),
        };
      }
      case SELECTOR.redeem: {
        const decoded = ERC4626.decodeFunctionData('redeem', data);
        return {
          kind: 'erc4626-redeem',
          selector,
          amount: BigInt(decoded[0]),
          receiver: getAddress(String(decoded[1])),
          owner: getAddress(String(decoded[2])),
        };
      }
      case SELECTOR.submit: {
        SAVAX.decodeFunctionData('submit', data);
        if (getAddress(to) !== SAVAX_ADDRESS) fail('submit() is only decoded for Benqi sAVAX');
        return { kind: 'savax-submit', selector, amount: options.value, receiver: options.wallet };
      }
      case SELECTOR.requestRedeem: {
        if (getAddress(to) !== SAVAX_ADDRESS) fail('requestRedeem is only decoded for Benqi sAVAX');
        const decoded = SAVAX.decodeFunctionData('requestRedeem', data);
        return { kind: 'savax-request-redeem', selector, amount: BigInt(decoded[0]), receiver: options.wallet };
      }
      case SELECTOR.swapTokensGeneric: {
        const decoded = LIFI.decodeFunctionData('swapTokensGeneric', data);
        const receiver = getAddress(String(decoded[3]));
        const minOut = BigInt(decoded[4]);
        const swaps = decoded[5] as Array<{ fromAmount: bigint }>;
        if (!swaps || swaps.length === 0) fail('Li.Fi swapTokensGeneric has no swap legs');
        let amount = 0n;
        for (const swap of swaps) amount += BigInt(swap.fromAmount);
        return { kind: 'lifi-swap', selector, amount, minOut, receiver };
      }
      default:
        fail(`Unknown selector ${selector} cannot be decoded and is denied`);
    }
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    fail(`Calldata for ${selector} could not be decoded`);
  }
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}
