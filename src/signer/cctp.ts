/**
 * Narrow CCTP V2. Off unless `chains[id].cctp.enabled` is true.
 *
 * Which chains may burn and receive is the `CCTP_CHAINS` table below.
 * Avalanche 43114 and Base 8453 may `depositForBurn` on TokenMessengerV2
 * and may approve their pinned native USDC to that messenger for the exact
 * burn amount. Avalanche, Base and Polygon 137 may `receiveMessage` on
 * MessageTransmitterV2. Arbitrum 42161 is listed but disabled, so it is
 * neither a local chain nor a remote domain. The mint
 * recipient in the burn body must be the treasury. The header sender and
 * the header recipient must both be TokenMessengerV2. MessageTransmitterV2
 * calls that recipient, and Circle's burn sets it to the remote messenger.
 * TokenMinterV2 mints the USDC; it is not the header recipient.
 *
 * Checked 19 October 2026 against Circle's contract list and domain table
 * (https://developers.circle.com/cctp/references/contract-addresses,
 * https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
 * and the V2 message layout
 * (https://developers.circle.com/cctp/references/technical-guide).
 * `depositForBurn` is `0x8e0250ee`. `receiveMessage` is `0x57ecfd28`.
 * Standard finality is 2000 and is fee-free. Fast finality is 1000 and is
 * denied. `localDomain()` is 1 on Avalanche, 6 on Base and 7 on Polygon.
 * Base was re-checked on 1 November 2026 against the same contract list and
 * Circle's USDC list (https://developers.circle.com/stablecoins/usdc-contract-addresses):
 * TokenMessengerV2, MessageTransmitterV2 and TokenMinterV2 are the same
 * addresses on Base, and Base native USDC is
 * `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
 *
 * Expiry: Circle's technical guide says an `expirationBlock` 24 hours ahead
 * is encoded before attestation. Attested mainnet Standard messages read
 * from Iris on 1 November 2026 (1->6 `0x07fabfb0...`, 6->1 `0x27e1c525...`,
 * plus the 1->7 rc.4 fixture) all carry `expirationBlock` 0, which matches
 * the whitepaper (Standard transfers do not expire; Fast ones do). So 0 is
 * the accepted value and a nonzero one still needs `maxExpirationBlock`.
 * `localMinter()` on both messengers is TokenMinterV2
 * `0xfd78ee919681417d192449715b2594ab58f5d002`.
 */

import { Interface, MaxUint256, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { DecodedCall } from './decode';
import { AVALANCHE_NATIVE_USDC, POLYGON_NATIVE_USDC } from './revoke-only';

export const CCTP_TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
export const CCTP_TOKEN_MINTER_V2 = '0xfd78ee919681417d192449715b2594ab58f5d002';
/** Circle Standard Transfer. Fast Transfer is 1000 and is denied. */
export const CCTP_STANDARD_FINALITY = 2000;
export const CCTP_AVALANCHE_DOMAIN = 1;
export const CCTP_ARBITRUM_DOMAIN = 3;
export const CCTP_BASE_DOMAIN = 6;
export const CCTP_POLYGON_DOMAIN = 7;
/** Circle native USDC on Base 8453. */
export const BASE_NATIVE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** Circle native USDC on Arbitrum 42161. Pinned for the disabled table entry only. */
export const ARBITRUM_NATIVE_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/**
 * Domain ids from Circle's domain table on 19 October 2026, plus X Layer 37
 * from the same day's contract-address table. An id outside this set is
 * rejected.
 */
const CIRCLE_DOMAINS = new Set([
  0, 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 25, 26, 27, 28, 29, 30, 31, 32, 37,
]);

/** One CCTP V2 chain. Adding a route is a new row here, then config. */
export interface CctpChainEntry {
  chainId: number;
  /** Circle domain id. */
  domain: number;
  name: string;
  /** Circle native USDC on this chain, the only burn token and the minted asset. */
  usdc: string;
  /** May sign `depositForBurn` and the exact messenger approval here. */
  burn: boolean;
  /**
   * Destination domains a burn from this chain may ever name. Config
   * `destinationDomains` must be a subset (startup fails otherwise), and a
   * burn to any other domain is denied even if config lists it. Each entry
   * must also be an enabled row that can receive. Empty when `burn` is false.
   */
  allowedDestinationDomains: readonly number[];
  /** May sign `receiveMessage` here. */
  receive: boolean;
  /**
   * A disabled row is neither a local chain nor a remote domain: config that
   * enables it or lists its domain fails startup, and calldata naming it is
   * denied.
   */
  enabled: boolean;
  /**
   * Which chain's block numbers `expirationBlock` counts when this chain is
   * the destination. Arbitrum stack counts Ethereum L1 blocks. Metadata
   * only: no code reads it yet. Enabling a row with 'ethereum' must
   * implement it first.
   */
  expirationClock: 'local' | 'ethereum';
}

export const CCTP_CHAINS: readonly CctpChainEntry[] = Object.freeze([
  // Avalanche keeps rc.7's Polygon route (7) and adds Base (6).
  { chainId: 43114, domain: CCTP_AVALANCHE_DOMAIN, name: 'Avalanche', usdc: getAddress(AVALANCHE_NATIVE_USDC), burn: true, allowedDestinationDomains: [CCTP_BASE_DOMAIN, CCTP_POLYGON_DOMAIN], receive: true, enabled: true, expirationClock: 'local' },
  // Base burns only back to Avalanche (1).
  { chainId: 8453, domain: CCTP_BASE_DOMAIN, name: 'Base', usdc: getAddress(BASE_NATIVE_USDC), burn: true, allowedDestinationDomains: [CCTP_AVALANCHE_DOMAIN], receive: true, enabled: true, expirationClock: 'local' },
  // Polygon is receive-only, as in rc.7.
  { chainId: 137, domain: CCTP_POLYGON_DOMAIN, name: 'Polygon', usdc: getAddress(POLYGON_NATIVE_USDC), burn: false, allowedDestinationDomains: [], receive: true, enabled: true, expirationClock: 'local' },
  // Not enabled. Flip `enabled` in a reviewed signer change, after the Base
  // round trip, then add config. Its expirationBlock is an L1 block number.
  // Avalanche would also need 3 in its allowedDestinationDomains.
  { chainId: 42161, domain: CCTP_ARBITRUM_DOMAIN, name: 'Arbitrum', usdc: getAddress(ARBITRUM_NATIVE_USDC), burn: true, allowedDestinationDomains: [CCTP_AVALANCHE_DOMAIN], receive: true, enabled: false, expirationClock: 'ethereum' },
].map((entry) => Object.freeze({ ...entry, allowedDestinationDomains: Object.freeze([...entry.allowedDestinationDomains]) } as CctpChainEntry)));

function enabledEntries(table: readonly CctpChainEntry[]): CctpChainEntry[] {
  return table.filter((entry) => entry.enabled);
}

/** Enabled CCTP row for a chain id, or undefined. */
export function cctpChain(chainId: number, table: readonly CctpChainEntry[] = CCTP_CHAINS): CctpChainEntry | undefined {
  return enabledEntries(table).find((entry) => entry.chainId === chainId);
}

/** Enabled CCTP row for a Circle domain, or undefined. */
export function cctpDomain(domain: number, table: readonly CctpChainEntry[] = CCTP_CHAINS): CctpChainEntry | undefined {
  return enabledEntries(table).find((entry) => entry.domain === domain);
}

const MESSENGER = getAddress(CCTP_TOKEN_MESSENGER_V2);
const TRANSMITTER = getAddress(CCTP_MESSAGE_TRANSMITTER_V2);

const HEADER_BYTES = 148;
const BODY_PREFIX_BYTES = 228;
const MESSAGE_VERSION = 1;

const MESSENGER_IFACE = new Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const TRANSMITTER_IFACE = new Interface([
  'function receiveMessage(bytes message, bytes attestation)',
]);
const ERC20 = new Interface(['function approve(address spender, uint256 amount)']);

const DEPOSIT = MESSENGER_IFACE.getFunction('depositForBurn')!.selector;
const RECEIVE = TRANSMITTER_IFACE.getFunction('receiveMessage')!.selector;
const APPROVE = ERC20.getFunction('approve')!.selector;

const KEYS = new Set([
  'enabled',
  'destinationDomains',
  'sourceDomains',
  'maxFee',
  'minFinalityThreshold',
  'destinationCaller',
  'maxExpirationBlock',
]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface CctpConfig {
  /** Default false. */
  enabled?: boolean;
  /**
   * Circle domain ids `depositForBurn` may name as destinationDomain. Each
   * must be an enabled `CCTP_CHAINS` row that can receive. Required when the
   * module is enabled on a chain that can burn (Avalanche, Base). Not used
   * on receive.
   */
  destinationDomains?: number[];
  /**
   * Circle domain ids a `receiveMessage` may name as its source domain. Each
   * must be an enabled `CCTP_CHAINS` row that can burn. Required when the module is
   * enabled on a receive-only chain (Polygon). Omitted on a chain that can
   * burn means this chain does not receive.
   */
  sourceDomains?: number[];
  /** Max `maxFee` in burn-token units. Omitted means 0, so the transfer is fee-free. */
  maxFee?: string;
  /**
   * Highest `expirationBlock` a receive may carry, as a decimal string.
   * Omitted means only 0 is accepted. 0 is always accepted. A message above
   * this bound is denied.
   */
  maxExpirationBlock?: string;
  /** Must be 2000 when the module is enabled. 1000 (Fast) is rejected. */
  minFinalityThreshold?: number;
  /** Address allowed to call `receiveMessage`. Omitted means bytes32(0), any caller. */
  destinationCaller?: string;
}

export function assertCctpConfig(
  config: CctpConfig | undefined,
  chainId: number,
  tokenCaps: Record<string, string>,
  label: string,
): void {
  if (config === undefined) return;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new EvalancheError(`${label} must be an object`, EvalancheErrorCode.INVALID_CONFIG);
  }
  const record = config as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.has(key)) throw new EvalancheError(`${label}.${key} is not a CCTP setting`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new EvalancheError(`${label}.enabled must be a boolean`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.destinationDomains !== undefined) parseDomains(record.destinationDomains, localDomain(chainId), `${label}.destinationDomains`);
  if (record.sourceDomains !== undefined) parseDomains(record.sourceDomains, localDomain(chainId), `${label}.sourceDomains`);
  if (record.maxFee !== undefined && (typeof record.maxFee !== 'string' || !DECIMAL.test(record.maxFee))) {
    throw new EvalancheError(`${label}.maxFee must be a decimal token amount`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.maxExpirationBlock !== undefined && (typeof record.maxExpirationBlock !== 'string' || !DECIMAL.test(record.maxExpirationBlock))) {
    throw new EvalancheError(`${label}.maxExpirationBlock must be a decimal block number`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.minFinalityThreshold !== undefined && record.minFinalityThreshold !== CCTP_STANDARD_FINALITY) {
    throw new EvalancheError(`${label}.minFinalityThreshold must be ${CCTP_STANDARD_FINALITY}`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.destinationCaller !== undefined) {
    try {
      getAddress(String(record.destinationCaller));
    } catch {
      throw new EvalancheError(`${label}.destinationCaller is not an address`, EvalancheErrorCode.INVALID_CONFIG);
    }
  }
  if (record.enabled !== true) return;
  const entry = cctpChain(chainId);
  if (entry === undefined) {
    throw new EvalancheError(`${label} is only supported on ${supportedChains()}`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (entry.burn && record.destinationDomains === undefined) {
    throw new EvalancheError(`${label}.destinationDomains is required`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (!entry.burn && record.sourceDomains === undefined) {
    throw new EvalancheError(`${label}.sourceDomains is required`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (record.destinationDomains !== undefined) {
    if (!entry.burn) {
      throw new EvalancheError(`${label}.destinationDomains is set but ${entry.name} ${chainId} does not burn`, EvalancheErrorCode.INVALID_CONFIG);
    }
    assertRouteDomains(record.destinationDomains as number[], 'receive', `${label}.destinationDomains`);
    for (const domain of record.destinationDomains as number[]) {
      if (!entry.allowedDestinationDomains.includes(domain)) {
        throw new EvalancheError(
          `${label}.destinationDomains has domain ${domain}, which ${entry.name} ${chainId} may not burn to (allowed: ${entry.allowedDestinationDomains.join(', ')})`,
          EvalancheErrorCode.INVALID_CONFIG,
        );
      }
    }
  }
  if (record.sourceDomains !== undefined) {
    if (!entry.receive) {
      throw new EvalancheError(`${label}.sourceDomains is set but ${entry.name} ${chainId} does not receive`, EvalancheErrorCode.INVALID_CONFIG);
    }
    assertRouteDomains(record.sourceDomains as number[], 'burn', `${label}.sourceDomains`);
  }
  if (record.minFinalityThreshold === undefined) {
    throw new EvalancheError(`${label}.minFinalityThreshold must be ${CCTP_STANDARD_FINALITY}`, EvalancheErrorCode.INVALID_CONFIG);
  }
  const token = entry.usdc;
  if (tokenCaps[token] === undefined) {
    throw new EvalancheError(`${label} requires a token cap for ${token}`, EvalancheErrorCode.INVALID_CONFIG);
  }
}

export function cctpEnabled(config: CctpConfig | undefined): boolean {
  return config?.enabled === true;
}

/** True when this call is owned by the CCTP decoder, so the selector allowlist does not apply. */
export function cctpModuleHandles(chainId: number, to: string, data: string, config: CctpConfig | undefined): boolean {
  if (!cctpEnabled(config)) return false;
  let address: string;
  try {
    address = getAddress(to);
  } catch {
    return false;
  }
  if (address === MESSENGER || address === TRANSMITTER) return true;
  const entry = cctpChain(chainId);
  if (!entry?.burn || address !== entry.usdc || selectorOf(data) !== APPROVE) return false;
  try {
    const decoded = ERC20.decodeFunctionData('approve', data);
    return getAddress(String(decoded[0])) === MESSENGER && BigInt(decoded[1]) > 0n;
  } catch {
    return false;
  }
}

/**
 * Decode a CCTP burn, a companion approval, or a destination receive.
 * Returns null when some other module should decide.
 */
export function takeCctp(input: {
  chainId: number | undefined;
  to: string;
  data: string;
  value: bigint;
  config: CctpConfig | undefined;
  wallet: string;
}): DecodedCall | null {
  if (!cctpEnabled(input.config) || input.chainId === undefined) return null;
  let target: string;
  try {
    target = getAddress(input.to);
  } catch {
    return null;
  }
  if (target === MESSENGER) return decodeBurn(input.chainId, input.data, input.value, input.config!, input.wallet);
  if (target === TRANSMITTER) return decodeReceive(input.chainId, input.data, input.value, input.config!, input.wallet);
  const entry = cctpChain(input.chainId);
  if (entry?.burn && target === entry.usdc && selectorOf(input.data) === APPROVE) {
    return decodeApproval(input.data, input.value, entry.usdc);
  }
  return null;
}

function decodeBurn(chainId: number, data: string, value: bigint, config: CctpConfig, wallet: string): DecodedCall {
  const local = cctpChain(chainId);
  if (!local?.burn) fail(`CCTP burn is only signed on ${burnChains()}`);
  if (selectorOf(data) !== DEPOSIT) fail('CCTP selector is not depositForBurn');
  assertValue(value);
  const decoded = decodeExact(MESSENGER_IFACE, 'depositForBurn', data);
  const amount = BigInt(decoded[0]);
  const destinationDomain = Number(decoded[1]);
  const mintRecipient = String(decoded[2]).toLowerCase();
  const burnToken = getAddress(String(decoded[3]));
  const destinationCaller = String(decoded[4]).toLowerCase();
  const maxFee = BigInt(decoded[5]);
  const minFinality = Number(decoded[6]);
  if (amount <= 0n) fail('CCTP burn amount must be greater than zero');
  if (!listed(config.destinationDomains, destinationDomain)) fail('CCTP destination domain is not allowlisted');
  const remote = cctpDomain(destinationDomain);
  if (!remote?.receive || remote.domain === local.domain) fail('CCTP destination domain is not an enabled CCTP route');
  if (!local.allowedDestinationDomains.includes(destinationDomain)) {
    fail(`CCTP burn from ${local.name} may not target domain ${destinationDomain}`);
  }
  if (mintRecipient !== addressToBytes32(wallet)) fail('CCTP mint recipient must be the treasury');
  if (burnToken !== local.usdc) fail(`CCTP burn token must be ${local.name} native USDC`);
  if (destinationCaller !== callerWord(config)) fail('CCTP destinationCaller does not match the pin');
  if (maxFee > feeCap(config)) fail('CCTP maxFee exceeds the configured cap');
  if (minFinality !== CCTP_STANDARD_FINALITY) fail(`CCTP minFinalityThreshold must be ${CCTP_STANDARD_FINALITY}`);
  return { kind: 'cctp-burn', selector: DEPOSIT, amount, asset: local.usdc, receiver: getAddress(wallet) };
}

function decodeApproval(data: string, value: bigint, usdc: string): DecodedCall | null {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = ERC20.decodeFunctionData('approve', data);
  } catch {
    return null;
  }
  const again = ERC20.encodeFunctionData('approve', decoded);
  if (again.toLowerCase() !== data.toLowerCase()) fail('CCTP approval has trailing bytes');
  let spender: string;
  try {
    spender = getAddress(String(decoded[0]));
  } catch {
    return null;
  }
  if (spender !== MESSENGER) return null;
  const amount = BigInt(decoded[1]);
  if (amount === 0n) return null;
  assertValue(value);
  if (amount === MaxUint256) fail('CCTP approval must be the exact burn amount');
  return {
    kind: 'erc20-approve',
    selector: APPROVE,
    amount,
    spender: MESSENGER,
    asset: usdc,
    moduleOp: 'cctp-approve',
  };
}

function decodeReceive(chainId: number, data: string, value: bigint, config: CctpConfig, wallet: string): DecodedCall {
  const entry = cctpChain(chainId);
  if (!entry?.receive) fail(`CCTP receive is only signed on ${receiveChains()}`);
  const local = entry.domain;
  if (selectorOf(data) !== RECEIVE) fail('CCTP selector is not receiveMessage');
  assertValue(value);
  const decoded = decodeExact(TRANSMITTER_IFACE, 'receiveMessage', data);
  const message = hexBytes(String(decoded[0]), 'CCTP message');
  const attestation = hexBytes(String(decoded[1]), 'CCTP attestation');
  if (attestation.length <= 2) fail('CCTP attestation is empty');
  const bytes = Buffer.from(message.slice(2), 'hex');
  if (bytes.length < HEADER_BYTES + BODY_PREFIX_BYTES) fail('CCTP message is too short');
  if (bytes.length > HEADER_BYTES + BODY_PREFIX_BYTES) fail('CCTP hook data is denied');
  const version = uint32(bytes, 0);
  const sourceDomain = uint32(bytes, 4);
  const destinationDomain = uint32(bytes, 8);
  const sender = bytes32(bytes, 44);
  const recipient = bytes32(bytes, 76);
  const destinationCaller = bytes32(bytes, 108);
  const minFinality = uint32(bytes, 140);
  const executed = uint32(bytes, 144);
  const bodyVersion = uint32(bytes, HEADER_BYTES);
  const burnToken = addressFromWord(bytes32(bytes, HEADER_BYTES + 4), 'CCTP burn token');
  const mintRecipient = bytes32(bytes, HEADER_BYTES + 36);
  const amount = uint256(bytes, HEADER_BYTES + 68);
  const messageSender = bytes32(bytes, HEADER_BYTES + 100);
  const maxFee = uint256(bytes, HEADER_BYTES + 132);
  const feeExecuted = uint256(bytes, HEADER_BYTES + 164);
  const expiration = uint256(bytes, HEADER_BYTES + 196);
  if (!expirationAllowed(config, expiration)) fail('CCTP expiration block is above the configured bound');
  if (version !== MESSAGE_VERSION || bodyVersion !== MESSAGE_VERSION) fail('CCTP message version is not 1');
  if (destinationDomain !== local) fail('CCTP message destination domain is not this chain');
  if (!listed(config.sourceDomains, sourceDomain)) fail('CCTP source domain is not allowlisted');
  // Same rule as startup: a source must be an enabled row that can burn.
  const source = cctpDomain(sourceDomain);
  if (!source?.burn) fail('CCTP source domain is not an enabled CCTP burn route');
  if (burnToken !== source.usdc) fail('CCTP burn token is not the pinned USDC for that domain');
  if (sender !== addressToBytes32(MESSENGER)) fail('CCTP message sender is not TokenMessengerV2');
  if (recipient !== addressToBytes32(MESSENGER)) fail('CCTP message recipient is not TokenMessengerV2');
  if (mintRecipient !== addressToBytes32(wallet)) fail('CCTP mint recipient must be the treasury');
  if (messageSender !== addressToBytes32(wallet)) fail('CCTP burn caller is not the treasury');
  if (destinationCaller !== callerWord(config)) fail('CCTP destinationCaller does not match the pin');
  if (minFinality !== CCTP_STANDARD_FINALITY || executed !== CCTP_STANDARD_FINALITY) {
    fail(`CCTP finality must be ${CCTP_STANDARD_FINALITY}`);
  }
  if (amount <= 0n) fail('CCTP mint amount must be greater than zero');
  if (maxFee > feeCap(config) || feeExecuted > maxFee) fail('CCTP fee exceeds the configured cap');
  if (feeExecuted >= amount) fail('CCTP fee leaves no USDC for the treasury');
  return { kind: 'cctp-mint', selector: RECEIVE, amount, asset: entry.usdc, receiver: getAddress(wallet) };
}

function listed(domains: number[] | undefined, domain: number): boolean {
  return (domains ?? []).some((entry) => entry === domain);
}

function expirationAllowed(config: CctpConfig, expiration: bigint): boolean {
  if (expiration === 0n) return true;
  if (typeof config.maxExpirationBlock !== 'string') return false;
  return expiration <= BigInt(config.maxExpirationBlock);
}

function feeCap(config: CctpConfig): bigint {
  return BigInt(config.maxFee ?? '0');
}

function callerWord(config: CctpConfig): string {
  if (!config.destinationCaller) return `0x${'0'.repeat(64)}`;
  return addressToBytes32(config.destinationCaller);
}

function localDomain(chainId: number): number | undefined {
  return cctpChain(chainId)?.domain;
}

function describeChains(entries: CctpChainEntry[]): string {
  const names = entries.map((entry) => `${entry.name} ${entry.chainId}`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function supportedChains(): string {
  return describeChains(enabledEntries(CCTP_CHAINS));
}

function burnChains(): string {
  return describeChains(enabledEntries(CCTP_CHAINS).filter((entry) => entry.burn));
}

function receiveChains(): string {
  return describeChains(enabledEntries(CCTP_CHAINS).filter((entry) => entry.receive));
}

/**
 * Every listed domain must be an enabled table row. `receive` (burn
 * destinations) also requires that the row can receive, so a burn never
 * targets a chain the signer cannot mint on. `burn` (receive sources) also
 * requires that the row can burn, so no source can be listed that the
 * treasury could never have burned from.
 */
function assertRouteDomains(domains: number[], need: 'receive' | 'burn', label: string): void {
  for (const domain of domains) {
    const remote = cctpDomain(domain);
    if (!remote || (need === 'receive' && !remote.receive) || (need === 'burn' && !remote.burn)) {
      const what = need === 'burn' ? 'an enabled CCTP chain that can burn' : 'an enabled CCTP route';
      throw new EvalancheError(`${label} has domain ${domain}, which is not ${what}`, EvalancheErrorCode.INVALID_CONFIG);
    }
  }
}

function parseDomains(value: unknown, local: number | undefined, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new EvalancheError(`${label} must be a non-empty domain list`, EvalancheErrorCode.INVALID_CONFIG);
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || !CIRCLE_DOMAINS.has(entry)) {
      throw new EvalancheError(`${label} has a domain that is not a Circle domain`, EvalancheErrorCode.INVALID_CONFIG);
    }
    if (local !== undefined && entry === local) {
      throw new EvalancheError(`${label} cannot list this chain's own domain`, EvalancheErrorCode.INVALID_CONFIG);
    }
    if (seen.has(entry)) throw new EvalancheError(`${label} lists a domain twice`, EvalancheErrorCode.INVALID_CONFIG);
    seen.add(entry);
  }
}

function addressToBytes32(address: string): string {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, '0')}`;
}

function selectorOf(data: string): string {
  return (data ?? '0x').toLowerCase().slice(0, 10);
}

function assertValue(value: bigint): void {
  if (value !== 0n) fail('CCTP transaction value must be 0');
}

function hexBytes(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) fail(`${label} is not hex`);
  return value.toLowerCase();
}

function uint32(bytes: Buffer, offset: number): number {
  return Number(uint256Raw(bytes, offset, 4));
}

function uint256(bytes: Buffer, offset: number): bigint {
  return uint256Raw(bytes, offset, 32);
}

function uint256Raw(bytes: Buffer, offset: number, size: number): bigint {
  return BigInt(`0x${bytes.subarray(offset, offset + size).toString('hex')}`);
}

function bytes32(bytes: Buffer, offset: number): string {
  return `0x${bytes.subarray(offset, offset + 32).toString('hex')}`;
}

function addressFromWord(word: string, label: string): string {
  if (!word.toLowerCase().startsWith('0x000000000000000000000000')) fail(`${label} is not an EVM address`);
  return getAddress(`0x${word.slice(-40)}`);
}

function decodeExact(iface: Interface, name: string, data: string): ReturnType<Interface['decodeFunctionData']> {
  let decoded: ReturnType<Interface['decodeFunctionData']>;
  try {
    decoded = iface.decodeFunctionData(name, data);
  } catch {
    fail(`CCTP calldata for ${name} could not be decoded`);
  }
  const again = iface.encodeFunctionData(name, decoded);
  if (again.toLowerCase() !== data.toLowerCase()) fail('CCTP calldata has trailing bytes');
  return decoded;
}

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.SIGNER_REJECTED);
}
