/** Independent public-byte fixtures; no Solana package or production codec. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  base58Decode, base58Encode, COMPUTE, deriveKey, LABELS, makeIntent, sha256, TOKEN, USDC, WSOL,
  type RecordValue,
} from './solana-test-helpers';

// This helper is also a new file: its own guard accompanies the importing suite's guard.
// PROVISIONAL — chosen by Builder on 26 Oct 2026 as the most cautious options; TO BE CONFIRMED BY GIACOMO. Change here only.
export const PROVISIONAL_SOLANA_POLICY = {
  maxFeeUsdDefault: '0.50',
  allowPoolTransfersDefault: false,
  maxPerTxUsdRequired: true,
} as const;

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 helper: fetch forbidden'); });
  vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => {
  try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); }
});

export { base58Encode, COMPUTE, TOKEN };
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const GENESIS = {
  'solana:mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  'solana:devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};
export const PROGRAMS = [JUPITER, SYSTEM, TOKEN, TOKEN_2022, ATA, COMPUTE];
export const key = (label: string): string => deriveKey(`evalanche-test-only/pr2/${label}`).pubkey;
/** Public synthetic pool metadata, not a reviewed or executable route. */
export function poolFixture() {
  return { ammProgram: key('amm-program'), pool: key('pool'), authority: key('pool-authority'),
    mintA: WSOL, mintB: USDC, vaultA: key('vault-a'), vaultB: key('vault-b') };
}


/** Compact-u16, not an unconstrained LEB128 encoder. */
export function shortvec(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('compact-u16 range');
  const out: number[] = [];
  do { const byte = value & 0x7f; value >>>= 7; out.push(byte | (value ? 0x80 : 0)); } while (value);
  return Buffer.from(out);
}
export interface WireInstruction { programIdIndex: number; accountIndices: number[]; data: Uint8Array }
export interface Lookup { accountKey: string; writable: number[]; readonly: number[] }
export interface MessageSpec {
  version: number;
  header: [number, number, number];
  keys: string[];
  blockhash: string;
  instructions: WireInstruction[];
  lookups: Lookup[];
}
function u32Data(tag: number, value: number): Buffer {
  const out = Buffer.alloc(5); out[0] = tag; out.writeUInt32LE(value, 1); return out;
}
export const limitData = (value = 400000): Buffer => u32Data(2, value);
export function priceData(value: bigint | string = '2500000'): Buffer {
  const out = Buffer.alloc(9); out[0] = 3; out.writeBigUInt64LE(BigInt(value), 1); return out;
}
export const heapFrameData = (value = 32768): Buffer => u32Data(1, value);
export const loadedData = (value = 65536): Buffer => u32Data(4, value);
export const instruction = (data: Uint8Array, programIdIndex = 1, accountIndices: number[] = []): WireInstruction => ({ programIdIndex, accountIndices, data });
export function messageSpec(): MessageSpec {
  return {
    version: 0x80, header: [1, 0, 2],
    keys: [deriveKey(LABELS.treasuryA).pubkey, COMPUTE, TOKEN],
    blockhash: base58Encode(sha256('evalanche-test-only/pr2/blockhash')),
    instructions: [instruction(limitData()), instruction(priceData()), instruction(Buffer.from([12]), 2, [0])],
    lookups: [],
  };
}
/** Parts expose exact byte boundaries for corruptions, without a second parser. */
export function messageParts(spec: MessageSpec = messageSpec()): Array<[string, Buffer]> {
  const parts: Array<[string, Buffer]> = [
    ['version', Buffer.from([spec.version])], ['header', Buffer.from(spec.header)],
    ['keyCount', shortvec(spec.keys.length)],
    ['keys', Buffer.concat(spec.keys.map(base58Decode))], ['blockhash', base58Decode(spec.blockhash)],
    ['instructionCount', shortvec(spec.instructions.length)],
  ];
  spec.instructions.forEach((ix, i) => parts.push(
    [`ix${i}.program`, Buffer.from([ix.programIdIndex])],
    [`ix${i}.accountCount`, shortvec(ix.accountIndices.length)],
    [`ix${i}.accounts`, Buffer.from(ix.accountIndices)],
    [`ix${i}.dataLength`, shortvec(ix.data.length)], [`ix${i}.data`, Buffer.from(ix.data)],
  ));
  parts.push(['lookupCount', shortvec(spec.lookups.length)]);
  spec.lookups.forEach((lookup, i) => parts.push(
    [`alt${i}.key`, base58Decode(lookup.accountKey)],
    [`alt${i}.writableCount`, shortvec(lookup.writable.length)], [`alt${i}.writable`, Buffer.from(lookup.writable)],
    [`alt${i}.readonlyCount`, shortvec(lookup.readonly.length)], [`alt${i}.readonly`, Buffer.from(lookup.readonly)],
  ));
  return parts;
}
export const encodeMessage = (spec: MessageSpec = messageSpec()): Buffer => Buffer.concat(messageParts(spec).map(([, bytes]) => bytes));
export function replacePart(name: string, bytes: number[], spec = messageSpec()): Buffer {
  const parts = messageParts(spec);
  if (!parts.some(([part]) => part === name)) throw new Error('unknown fixture part');
  return Buffer.concat(parts.map(([part, data]) => part === name ? Buffer.from(bytes) : data));
}
export function offsetOf(name: string, spec = messageSpec()): number {
  let offset = 0;
  for (const [part, bytes] of messageParts(spec)) { if (part === name) return offset; offset += bytes.length; }
  throw new Error('unknown fixture part');
}
export const routeHash = (bytes: Uint8Array): string => '0x' + createHash('sha256').update(bytes).digest('hex');
/** Synthetic policy fixture, not a valid executable SPL/Jupiter route. */
export function messageIntent(spec = messageSpec(), limit = 400000, price = '2500000'): RecordValue {
  const intent = makeIntent('approve'); const bytes = encodeMessage(spec);
  intent.wallet = spec.keys[0]; intent.routeHash = routeHash(bytes);
  intent.tx = { ...intent.tx, serializedMessage: bytes.toString('base64'), recentBlockhash: spec.blockhash,
    computeUnitLimit: limit, computeUnitPriceMicroLamports: price };
  intent.programIds = [...new Set(spec.instructions.map((ix) => spec.keys[ix.programIdIndex]))].sort();
  return intent;
}
