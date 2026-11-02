/** PR3 offline contracts. Builder's 1 Nov 2026 decisions override spec defaults/Token-2022. */
import { existsSync } from 'node:fs';
import { expect } from 'vitest';
import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/addresses';
import * as intentModule from '../../../src/signer/solana-intent';
import * as configModule from '../../../src/signer/solana-policy';
import { makeIntent, requireFn, USDC, WSOL, type RecordValue } from '../solana-test-helpers';
import { ATA, COMPUTE, encodeMessage, GENESIS, key, limitData, messageSpec, priceData, PROGRAMS,
  routeHash, SYSTEM, TOKEN, TOKEN_2022, USDT, type MessageSpec } from '../solana-message-helpers';
// Importing solana-message-helpers installs the same beforeEach/afterEach offline fetch guard as PR2.
export { requireFn, USDC, WSOL, ATA, COMPUTE, key, limitData, priceData, SYSTEM, TOKEN, TOKEN_2022, USDT };
export { intentModule, configModule };
export const MAINNET = 'solana:mainnet';
const decoderPath = '../../../src/signer/' + 'solana-decode/index.ts';
export async function loadDecoder(): Promise<RecordValue> {
  try { return await import(/* @vite-ignore */ decoderPath); }
  catch (error) {
    const e = error as NodeJS.ErrnoException;
    // Never hide a syntax error, an initialization failure, or a missing dependency in a future module.
    if (!existsSync(new URL(decoderPath, import.meta.url))
      && ['ERR_MODULE_NOT_FOUND', 'ERR_LOAD_URL'].includes(e.code ?? '')
      && /solana-decode\/index\.ts/.test(e.message)) return {};
    throw error;
  }
}
export const mod = await loadDecoder();
export const toJson = (value: unknown): any => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
/** Only amount-bearing JSON fields are bigint; indices, decimals and units remain numbers. */
export function fromJson<T = any>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (k, v) => ['amount', 'lamports', 'microLamports', 'priorityFeeLamports'].includes(k) ? BigInt(v) : v);
}
export function expectDeny(fn: () => unknown, reason: string, instructionIndex?: number): void {
  const Denial = requireFn(mod, 'SolanaPolicyDenial');
  let caught: any;
  try { fn(); } catch (e) { caught = e; }
  expect(caught, `expected ${reason}`).toBeInstanceOf(Denial);
  expect(caught.reason).toBe(reason);
  if (instructionIndex !== undefined) expect(caught.instructionIndex).toBe(instructionIndex);
  expect(caught.message.startsWith(`${reason}: `)).toBe(true);
  expect(caught.message).not.toContain('http');
  expect(caught.message).not.toContain(template().secretKeyPath);
}
export const MINTS = {
  [WSOL]: { symbol: 'wSOL', decimals: 9, tokenProgram: TOKEN },
  [USDC]: { symbol: 'USDC', decimals: 6, tokenProgram: TOKEN },
  [USDT]: { symbol: 'USDT', decimals: 6, tokenProgram: TOKEN },
};
/** Same explicit template shape as PR2; these are fixture economics, never defaults. */
export function template(enabled = true): RecordValue {
  return { enabled, secretKeyPath: '/tmp/evalanche-test-only-never-read/solana.key', clusters: {
    [MAINNET]: { enabled, killSwitch: false,
      rpcUrls: ['https://rpc-a.example.org', 'https://rpc-b.example.org'], rpcQuorum: 2, rpcTimeoutMs: 8000,
      genesisHash: GENESIS[MAINNET], programs: [...PROGRAMS], innerPrograms: [], mints: structuredClone(MINTS),
      delegates: [key('delegate')], nonceAccounts: [], alt: { enabled: false }, allowWsol: true,
      jupiter: { enabled: false, allowPoolTransfers: false, pools: [], apiBaseUrl: 'https://api.jup.ag/swap/v1' },
      fees: { maxComputeUnitLimit: 400000, maxComputeUnitPriceMicroLamports: '2500000', maxPriorityFeeLamports: '1000000', maxFeeUsd: '2.00' },
      maxSlippageBps: 100, quoteMaxAgeMs: 30000, maxIntentTtlMs: 120000, maxPerTxUsd: '100', maxRentLamports: '3000000',
      tokenCaps: { native: '1000000000', [WSOL]: '1000000000', [USDC]: '100000000', [USDT]: '100000000' },
      price: { ids: { native: 'solana' }, priceFeed: { provider: 'coingecko', maxAgeMs: 600000 },
        bounds: { native: { min: 1, max: 1000 }, [WSOL]: { min: 1, max: 1000 }, [USDC]: { min: 0.5, max: 2 }, [USDT]: { min: 0.5, max: 2 } },
        prices: { native: 100, [WSOL]: 100, [USDC]: 1, [USDT]: 1 } },
    }, 'solana:devnet': { enabled: false },
  } };
}
export async function oracleAta(wallet: string, mint: string, tokenProgram = TOKEN) {
  const enc = getAddressEncoder();
  return getProgramDerivedAddress({ programAddress: ATA as Address,
    seeds: [enc.encode(wallet as Address), enc.encode(tokenProgram as Address), enc.encode(mint as Address)] });
}
export async function policyContext(treasury = key('treasury'), profile: RecordValue = {}) {
  const input = template(); const c = input.clusters[MAINNET];
  const { resolvedMutation, ...patch } = profile;
  // Profile is a serializable patch to an explicit template, not an alternate config parser.
  for (const [field, value] of Object.entries(patch)) {
    c[field] = value && typeof value === 'object' && !Array.isArray(value) ? { ...c[field], ...value } : value;
  }
  const resolved = requireFn(configModule, 'resolveSolanaConfig')(input);
  requireFn(configModule, 'assertSolanaClusterReady')(resolved, MAINNET);
  const context = { cluster: MAINNET, config: resolved.clusters[MAINNET], treasury,
    treasuryAtas: await requireFn(mod, 'deriveTreasuryAtas')(treasury, c.mints) };
  // Explicit post-resolution mutations exercise callers passing an incomplete resolved context.
  if (resolvedMutation?.removeMint) delete context.config.mints[resolvedMutation.removeMint];
  if (resolvedMutation?.removeCap) delete context.config.tokenCaps[resolvedMutation.removeCap];
  if (resolvedMutation?.mintTokenProgram) {
    const { mint, tokenProgram } = resolvedMutation.mintTokenProgram;
    context.config.mints[mint].tokenProgram = tokenProgram;
  }
  return context;
}
export type Meta = { address: string; writable?: boolean; signer?: boolean };
export type Ix = { program: string; data: Uint8Array; accounts: Meta[] };
export const meta = (address: string, writable = false, signer = false): Meta => ({ address, writable, signer });
export const ix = (program: string, data: Uint8Array, accounts: Meta[] = []): Ix => ({ program, data, accounts });
export const budget = (units = 400000, price = '2500000'): Ix[] => [ix(COMPUTE, limitData(units)), ix(COMPUTE, priceData(price))];
export function u32(tag: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(tag); return b; }
export function systemData(amount = '100'): Buffer { const b = Buffer.alloc(12); b.writeUInt32LE(2); b.writeBigUInt64LE(BigInt(amount), 4); return b; }
export function checkedData(tag = 13, amount = '100', decimals = 6): Buffer {
  const b = Buffer.alloc(10); b[0] = tag; b.writeBigUInt64LE(BigInt(amount), 1); b[9] = decimals; return b;
}
/** Compile only fixture metadata; wire encoding is the existing PR2 encoder. */
export function rewrap(...instructions: Ix[]): Buffer { return encodeMessage(buildSpec(instructions)); }
export function buildSpec(instructions: Ix[], payer = key('treasury')): MessageSpec {
  const roles = new Map<string, Meta>([[payer, meta(payer, true, true)]]);
  for (const i of instructions) for (const a of [...i.accounts, meta(i.program)]) {
    const old = roles.get(a.address);
    roles.set(a.address, meta(a.address, !!(a.writable || old?.writable), !!(a.signer || old?.signer)));
  }
  if ([...roles.values()].some(a => a.signer && a.address !== payer)) throw new Error('one-signer fixture only');
  const keys = [payer, ...[...roles.values()].filter(a => a.address !== payer && a.writable).map(a => a.address),
    ...[...roles.values()].filter(a => a.address !== payer && !a.writable).map(a => a.address)];
  return { ...messageSpec(), keys, header: [1, 0, [...roles.values()].filter(a => !a.writable && a.address !== payer).length],
    instructions: instructions.map(i => ({ programIdIndex: keys.indexOf(i.program), accountIndices: i.accounts.map(a => keys.indexOf(a.address)), data: i.data })) };
}
export const parse = (bytes: Uint8Array | string) => requireFn(intentModule, 'parseSolanaMessage')(bytes);
export function inputAt(message: any, instructionIndex: number) {
  return { message, accounts: requireFn(mod, 'accountRoles')(message), instructionIndex, instruction: message.instructions[instructionIndex] };
}
/** PR1-valid and byte-bound; schema validation also runs for every fixture consumed by tests. */
export function boundIntent(bytes: Uint8Array, fields: RecordValue = {}): RecordValue {
  const message = parse(bytes); const intent = makeIntent(fields.action ?? 'transfer');
  const limit = message.instructions.find((i: any) => i.programId === COMPUTE && i.data[0] === 2 && i.data.length === 5);
  const price = message.instructions.find((i: any) => i.programId === COMPUTE && i.data[0] === 3 && i.data.length === 9);
  Object.assign(intent, { wallet: message.staticAccountKeys[0], venue: 'spl-token', amountIn: '0', ...fields,
    routeHash: routeHash(bytes), tx: { serializedMessage: Buffer.from(bytes).toString('base64'), recentBlockhash: message.recentBlockhash,
      lastValidBlockHeight: 300000100, computeUnitLimit: limit ? Buffer.from(limit.data).readUInt32LE(1) : 400000,
      computeUnitPriceMicroLamports: price ? Buffer.from(price.data).readBigUInt64LE(1).toString() : '2500000' },
    programIds: [...new Set(message.instructions.flatMap((i: any) => i.programId === ATA
      ? [i.programId, SYSTEM, message.staticAccountKeys[i.accountIndices[5]]] : [i.programId]))].sort() });
  expect(requireFn(intentModule, 'assertSolanaIntentShape')(intent)).toEqual(intent);
  return intent;
}
export function assertIntent(intent: any) { expect(requireFn(intentModule, 'assertSolanaIntentShape')(intent)).toEqual(intent); }
export const decode = (bytes: Uint8Array) => requireFn(mod, 'decodeSolanaMessage')(parse(bytes));
