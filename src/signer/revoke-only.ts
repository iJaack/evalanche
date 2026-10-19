/**
 * Revoke-only calls. Off unless `chains[id].revokeOnly.enabled` is true.
 *
 * Once enabled, two shapes are accepted on an enabled chain:
 * `approve(anySpender, 0)` and `setApprovalForAll(operator, false)`.
 * The token must have the `token` role or be a pinned known USDC.
 * A router or any other allowlisted contract is out of scope.
 * A positive amount, `operator = true`, permit, increaseAllowance, a nonzero
 * value, and trailing calldata are denied. pUSD stays on the Polymarket
 * deny list and is not a known revoke token.
 *
 * Known tokens, checked 19 October 2026:
 * Polygon USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (Polymarket
 * registry; `symbol()` USDC, 6 decimals, 2037 bytes).
 * Polygon native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
 * (Circle USDC contract list; `symbol()` USDC, 6 decimals, 1852 bytes).
 * Avalanche native USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`
 * (Circle; `symbol()` USDC, 6 decimals).
 */

import { Interface, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { POLYMARKET_DENY_CONTRACTS } from './polymarket-addresses';
import type { DecodedCall } from './decode';

export interface RevokeOnlyConfig {
  /** Default false. True allows only the two revoke shapes above. */
  enabled?: boolean;
}

/** Polygon bridged USDC.e. */
export const POLYGON_USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** Polygon native USDC. */
export const POLYGON_NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
/** Avalanche native USDC. */
export const AVALANCHE_NATIVE_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

const KNOWN_BY_CHAIN: Readonly<Record<number, readonly string[]>> = {
  137: [POLYGON_USDC_E, POLYGON_NATIVE_USDC],
  43114: [AVALANCHE_NATIVE_USDC],
};

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

const ERC1155 = new Interface([
  'function setApprovalForAll(address operator, bool approved)',
]);

const PERMIT2 = new Interface([
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
]);

const APPROVE = ERC20.getFunction('approve')!.selector;
const INCREASE = ERC20.getFunction('increaseAllowance')!.selector;
const PERMIT = ERC20.getFunction('permit')!.selector;
const PERMIT2_SELECTOR = PERMIT2.getFunction('permit')!.selector;
const SET_APPROVAL = ERC1155.getFunction('setApprovalForAll')!.selector;

const REVOKED = new Set([APPROVE, INCREASE, PERMIT, PERMIT2_SELECTOR, SET_APPROVAL]);
const DENIED = new Set(POLYMARKET_DENY_CONTRACTS.map((address) => getAddress(address)));

export function assertRevokeOnlyConfig(config: RevokeOnlyConfig | undefined, label: string): void {
  if (config === undefined) return;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new EvalancheError(`${label} must be an object`, EvalancheErrorCode.INVALID_CONFIG);
  }
  const record = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'enabled') {
      throw new EvalancheError(`${label}.${key} is not a revoke-only setting`, EvalancheErrorCode.INVALID_CONFIG);
    }
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new EvalancheError(`${label}.enabled must be a boolean`, EvalancheErrorCode.INVALID_CONFIG);
  }
}

export function revokeOnlyEnabled(config: RevokeOnlyConfig | undefined): boolean {
  return config?.enabled === true;
}

export function isKnownRevokeToken(chainId: number, address: string): boolean {
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    return false;
  }
  return (KNOWN_BY_CHAIN[chainId] ?? []).some((token) => getAddress(token) === checksum);
}

export function isRevokeOnlySelector(data: string): boolean {
  const selector = (data ?? '0x').toLowerCase().slice(0, 10);
  return REVOKED.has(selector);
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}

function decodeExact(iface: Interface, name: string, data: string): ReturnType<Interface['decodeFunctionData']> {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = iface.decodeFunctionData(name, data);
  } catch {
    fail(`revoke calldata for ${name} could not be decoded`);
  }
  const again = iface.encodeFunctionData(name, decoded);
  if (again.toLowerCase() !== data.toLowerCase()) fail('revoke calldata has trailing bytes');
  return decoded;
}

/**
 * Accept a zero approval or a false `setApprovalForAll`, or refuse an abuse
 * of that path. Returns null when the existing allow map should decide.
 */
export function takeRevokeOnly(input: {
  to: string;
  data: string;
  value: bigint;
  enabled: boolean;
  inScope: boolean;
  spenderAllowed: boolean;
}): DecodedCall | null {
  if (!input.enabled) return null;
  const selector = input.data.toLowerCase().slice(0, 10);
  if (!REVOKED.has(selector)) return null;
  let target: string;
  try {
    target = getAddress(input.to);
  } catch {
    fail('revoke token is not an address');
  }
  if (DENIED.has(target)) return null;
  if (!input.inScope) return null;
  if (selector === INCREASE || selector === PERMIT || selector === PERMIT2_SELECTOR) {
    fail('revoke-only denies permit and increaseAllowance');
  }
  if (input.value !== 0n) fail('revoke transaction value must be 0');
  if (selector === APPROVE) {
    const decoded = decodeExact(ERC20, 'approve', input.data);
    const spender = getAddress(String(decoded[0]));
    const amount = BigInt(decoded[1]);
    if (amount !== 0n) {
      if (!input.spenderAllowed) fail('revoke-only allows only a zero amount');
      return null;
    }
    return { kind: 'erc20-approve', selector, amount: 0n, spender, asset: target, moduleOp: 'revoke' };
  }
  if (selector === SET_APPROVAL) {
    const decoded = decodeExact(ERC1155, 'setApprovalForAll', input.data);
    const operator = getAddress(String(decoded[0]));
    if (decoded[1] !== false) fail('setApprovalForAll(operator, true) is denied');
    return { kind: 'erc20-approve', selector, amount: 0n, spender: operator, asset: target, moduleOp: 'revoke' };
  }
  fail(`revoke selector ${selector} is denied`);
}
