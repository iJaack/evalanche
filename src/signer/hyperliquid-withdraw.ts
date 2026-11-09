import { readFile } from 'node:fs/promises';
import { getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { CanonicalSigningRequest, SigningIntent, TypedDataPayload } from './intent';
import { writeDurable } from './nonce-store';

export const HYPERLIQUID_WITHDRAW_DESTINATION = '0x0fe61780bd5508b3c99e420662050e5560608ca4';
export const HYPERLIQUID_SIGNATURE_CHAIN_ID = 421614;
export const HYPERLIQUID_WITHDRAW_TYPE = 'HyperliquidTransaction:Withdraw';
export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
// HL accepts T-2d..T+1d; signer approvals deliberately use a much tighter window.
export const HL_WITHDRAW_MAX_AGE_MS = 300_000;
export const HL_WITHDRAW_MAX_FUTURE_MS = 60_000;
export const HL_WITHDRAW_MAX_USDC = '35';
const WITHDRAW_FIELDS = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'destination', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'time', type: 'uint64' },
];
const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const AMOUNT = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const BALANCE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface HyperliquidWithdrawAudit {
  action: 'withdraw3';
  destination?: string;
  amount?: string;
  time?: number;
  withdrawable?: string;
}

/** Code-only injection; never part of the signer JSON options. */
export type HyperliquidInfoFetcher = (user: string) => Promise<unknown>;
export const fetchHyperliquidInfo: HyperliquidInfoFetcher = async (user) => {
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: user.toLowerCase() }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) reject('clearinghouseState HTTP response was not successful');
  return response.json();
};

function reject(reason: string): never {
  throw new EvalancheError(`Hyperliquid withdraw3: ${reason}`, EvalancheErrorCode.SIGNER_REJECTED);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: unknown, keys: string[]): boolean {
  return object(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function fields(value: unknown, expected: typeof WITHDRAW_FIELDS): boolean {
  return Array.isArray(value) && value.length === expected.length
    && expected.every((field, i) => exactKeys(value[i], ['name', 'type'])
      && value[i].name === field.name && value[i].type === field.type);
}

function assertSchema(typed: TypedDataPayload): void {
  const { domain, types, value } = typed;
  if (!exactKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'])
    || domain.name !== 'HyperliquidSignTransaction' || domain.version !== '1'
    || domain.chainId !== HYPERLIQUID_SIGNATURE_CHAIN_ID
    || domain.verifyingContract !== '0x0000000000000000000000000000000000000000') {
    reject('domain must exactly match the SDK signing domain');
  }
  if (!exactKeys(types, [HYPERLIQUID_WITHDRAW_TYPE])
    && !exactKeys(types, [HYPERLIQUID_WITHDRAW_TYPE, 'EIP712Domain'])) reject('unexpected types');
  if (!fields(types[HYPERLIQUID_WITHDRAW_TYPE], WITHDRAW_FIELDS)) reject('invalid Withdraw fields');
  if ('EIP712Domain' in types && !fields(types.EIP712Domain, DOMAIN_FIELDS)) reject('invalid EIP712Domain fields');
  if ('primaryType' in typed && typed.primaryType !== HYPERLIQUID_WITHDRAW_TYPE) reject('invalid primaryType');
  if (!exactKeys(value, ['hyperliquidChain', 'destination', 'amount', 'time'])) reject('unexpected value keys');
}

/** Structural gate only: semantic checks still run before any balance read or signing. */
export function isHyperliquidWithdraw3(request: CanonicalSigningRequest, enabled: boolean): boolean {
  if (!enabled || request.kind !== 'typed-data' || request.chainId !== HYPERLIQUID_SIGNATURE_CHAIN_ID || !request.typedData) return false;
  try { assertSchema(request.typedData); return true; } catch { return false; }
}

export function assertHyperliquidWithdraw3(request: CanonicalSigningRequest, intent: SigningIntent, now = Date.now(), maxUsdc?: unknown): void {
  if (!request.typedData) reject('typedData is required');
  assertSchema(request.typedData);
  const value = request.typedData.value;
  if (value.hyperliquidChain !== 'Mainnet') reject('hyperliquidChain must be Mainnet');
  if (value.destination !== HYPERLIQUID_WITHDRAW_DESTINATION) reject('destination must be the exact lowercase pinned treasury');
  if (typeof value.amount !== 'string' || !AMOUNT.test(value.amount) || units(value.amount) === 0n) reject('amount must be a positive decimal string with at most 6 decimals');
  if (units(value.amount) > withdrawCapUnits(maxUsdc)) reject('amount exceeds the per-withdrawal cap');
  if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time) || value.time < 0) reject('time must be a safe non-negative integer number');
  if (value.time < now - HL_WITHDRAW_MAX_AGE_MS || value.time > now + HL_WITHDRAW_MAX_FUTURE_MS) reject('time is outside the freshness window');
  if (intent.venue !== 'hyperliquid' || intent.action !== 'hyperliquid-withdraw') reject('intent must bind hyperliquid / hyperliquid-withdraw');
  if (request.chainId !== HYPERLIQUID_SIGNATURE_CHAIN_ID || intent.chainId !== HYPERLIQUID_SIGNATURE_CHAIN_ID) reject('request and intent chainId must be 421614');
}

function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function withdrawCapUnits(value: unknown): bigint {
  const hardCap = units(HL_WITHDRAW_MAX_USDC);
  if (typeof value === 'string') {
    if (!AMOUNT.test(value)) return hardCap;
    const cap = units(value);
    return cap > 0n && cap <= hardCap ? cap : hardCap;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > Number(HL_WITHDRAW_MAX_USDC)) return hardCap;
  // Work from the decimal representation, including small exponential numbers.
  // Integer division truncates to six decimals without floating-point rounding up.
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  const micros = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  return micros * 100n;
}

export async function assertHyperliquidBalance(fetcher: HyperliquidInfoFetcher, wallet: string, amount: string, audit: HyperliquidWithdrawAudit): Promise<void> {
  let state: unknown;
  try { state = await fetcher(wallet.toLowerCase()); }
  catch { reject('clearinghouseState read failed'); }
  if (!object(state)) reject('clearinghouseState must be an object');
  if (typeof state.withdrawable !== 'string' || !BALANCE.test(state.withdrawable)) reject('invalid withdrawable balance');
  audit.withdrawable = state.withdrawable;
  if (typeof state.time !== 'number' || !Number.isSafeInteger(state.time) || state.time < 0 || Math.abs(Date.now() - state.time) > 30_000) reject('clearinghouseState time is missing or outside 30000ms');
  if (!Array.isArray(state.assetPositions) || state.assetPositions.length !== 0) reject('assetPositions must be an empty array');
  if (units(amount) > units(state.withdrawable)) reject('amount exceeds withdrawable balance');
}

interface HyperliquidNonceFile {
  version: 1;
  wallets: Record<string, { lastTime: string; used: string[] }>;
}
export function hyperliquidNoncePath(nonceStorePath: string): string { return `${nonceStorePath}.hyperliquid.json`; }

export class HyperliquidNonceStore {
  private file: HyperliquidNonceFile = { version: 1, wallets: {} };
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const file: unknown = JSON.parse(raw);
      if (!exactKeys(file, ['version', 'wallets']) || !object(file) || file.version !== 1 || !object(file.wallets)) throw new Error();
      for (const [wallet, entry] of Object.entries(file.wallets)) {
        if (getAddress(wallet).toLowerCase() !== wallet || !exactKeys(entry, ['lastTime', 'used']) || !object(entry)
          || typeof entry.lastTime !== 'string' || !DECIMAL.test(entry.lastTime)
          || !Array.isArray(entry.used) || entry.used.length < 1 || entry.used.length > 100
          || entry.used.some((time, i, all) => typeof time !== 'string' || !DECIMAL.test(time)
            || BigInt(time) > BigInt(entry.lastTime as string) || (i > 0 && BigInt(time) <= BigInt(all[i - 1])))
          || entry.used.at(-1) !== entry.lastTime) throw new Error();
      }
      this.file = file as unknown as HyperliquidNonceFile;
    } catch {
      throw new EvalancheError('Hyperliquid nonce store is corrupt', EvalancheErrorCode.INVALID_CONFIG);
    }
  }

  assertFresh(wallet: string, time: number): void {
    const previous = this.file.wallets[wallet.toLowerCase()];
    if (previous && BigInt(time) <= BigInt(previous.lastTime)) reject('time must be greater than the last recorded Hyperliquid nonce');
  }

  async record(wallet: string, time: number): Promise<void> {
    this.assertFresh(wallet, time);
    const key = wallet.toLowerCase();
    const decimal = String(time);
    this.file.wallets[key] = { lastTime: decimal, used: [...(this.file.wallets[key]?.used ?? []), decimal].slice(-100) };
    await writeDurable(this.path, `${JSON.stringify(this.file)}\n`);
  }
}
