/** Offline Solana schema and approval domain. Wire parsing and policy belong to later PRs. */
import { createHash } from 'node:crypto';
import { decodeBase58 } from './base58';
import type { ApprovalDecision, ApprovalMode, VerifierApproval } from './intent';

export const SOLANA_APPROVAL_DOMAIN = 'evalanche-verifier/solana/v1\0';
export const SOLANA_CLUSTERS = ['solana:mainnet', 'solana:devnet'] as const;
export type SolanaChainId = typeof SOLANA_CLUSTERS[number];

export interface SolanaTokenRef {
  mint: string;
  symbol: string;
  decimals: number;
}

export type SolanaTransaction = {
  serializedMessage: string;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: string;
} & ({ recentBlockhash: string; lastValidBlockHeight: number } | {
  durableNonce: { nonceAccount: string; nonceAuthority: string; nonceValue: string };
});

interface SolanaIntentBase {
  version: '1';
  intentId: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  wallet: string;
  chainId: SolanaChainId;
  routeHash: string;
  tx: SolanaTransaction;
  tokenIn: SolanaTokenRef;
  amountIn: string;
  programIds: string[];
}

export type SolanaSigningIntent = SolanaIntentBase & ({
  action: 'swap';
  venue: 'jupiter-v6';
  tokenOut: SolanaTokenRef;
  minAmountOut: string;
  quotedAmountOut: string;
  slippageBps: number;
  maxSlippageBps: number;
  quoteId: string;
  quotedAt: number;
} | { action: 'approve' | 'revoke'; venue: 'spl-token' }
  | { action: 'transfer'; venue: 'spl-token' | 'system' });

export interface SolanaSigningRequest {
  requestId: string;
  kind: 'transaction';
  chainId: SolanaChainId;
  from: string;
  intent: string;
  structuredIntent: SolanaSigningIntent;
  approval: VerifierApproval | null;
}

const COMMON_FIELDS = [
  'version', 'intentId', 'nonce', 'createdAt', 'expiresAt', 'wallet', 'chainId',
  'venue', 'action', 'routeHash', 'tx', 'tokenIn', 'amountIn', 'programIds',
];
const SWAP_FIELDS = ['tokenOut', 'minAmountOut', 'quotedAmountOut', 'slippageBps', 'maxSlippageBps', 'quoteId', 'quotedAt'];
const APPROVAL_FIELDS = ['intentHash', 'nonce', 'expiresAt', 'verifier', 'signature', 'decision', 'mode', 'signerAddress'];
const U64_MAX = 2n ** 64n - 1n;

function reject(message: string): never {
  throw new Error(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  const record = object(value, label);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !fields.includes(key)) {
      reject(`${label} has forbidden or unknown field ${String(key)}`);
    }
    if (!('value' in Object.getOwnPropertyDescriptor(record, key)!)) reject(`${label}.${key} must be a data field`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) reject(`${label}.${key} is required`);
  }
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) reject(`${label} must be a nonempty string without NUL`);
  return value.normalize('NFC');
}

function pubkey(value: unknown, label: string): string {
  try { decodeBase58(value); } catch { reject(`${label} must be a canonical base58 32-byte public key or blockhash`); }
  return value as string;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    reject(`${label} must be a safe integer from ${min} to ${max}`);
  }
  return value;
}

function decimal(value: unknown, label: string, u64 = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) reject(`${label} must be a canonical unsigned decimal string`);
  if (u64 && (value.length > 20 || BigInt(value) > U64_MAX)) reject(`${label} exceeds u64`);
  return value;
}

function hex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) reject(`${label} must be ${bytes}-byte hex`);
  return value;
}

function decision(value: unknown): ApprovalDecision {
  if (value !== 'approve' && value !== 'deny') reject('Invalid Solana approval decision');
  return value;
}

function mode(value: unknown): ApprovalMode {
  if (value !== 'live' && value !== 'dry-run') reject('Invalid Solana approval mode');
  return value;
}

/** Recognize only the two exact, case-sensitive Solana cluster ids. */
export function isSolanaChainId(value: unknown): value is SolanaChainId {
  return value === 'solana:mainnet' || value === 'solana:devnet';
}

function cluster(value: unknown): SolanaChainId {
  if (!isSolanaChainId(value)) reject('Invalid Solana cluster chainId');
  return value;
}

function messageBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    reject('serializedMessage must be canonical padded base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) reject('serializedMessage must be canonical base64');
  return bytes;
}

/** SHA-256 of decoded message bytes, never of the base64 carrier text. */
export function computeSolanaRouteHash(message: string | Uint8Array): string {
  const bytes = typeof message === 'string' ? messageBytes(message) : message;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) reject('Solana message bytes are required');
  return '0x' + createHash('sha256').update(bytes).digest('hex');
}

function token(value: unknown, label: string): SolanaTokenRef {
  const record = exact(value, ['mint', 'symbol', 'decimals'], label);
  return { mint: pubkey(record.mint, `${label}.mint`), symbol: text(record.symbol, `${label}.symbol`), decimals: integer(record.decimals, `${label}.decimals`, 0, 255) };
}

function transaction(value: unknown, wallet: string): SolanaTransaction {
  const record = object(value, 'tx');
  const durable = Object.hasOwn(record, 'durableNonce');
  exact(record, ['serializedMessage', 'computeUnitLimit', 'computeUnitPriceMicroLamports',
    ...(durable ? ['durableNonce'] : ['recentBlockhash', 'lastValidBlockHeight'])], 'tx');
  messageBytes(record.serializedMessage);
  const common = {
    serializedMessage: record.serializedMessage as string,
    computeUnitLimit: integer(record.computeUnitLimit, 'tx.computeUnitLimit', 1),
    computeUnitPriceMicroLamports: decimal(record.computeUnitPriceMicroLamports, 'tx.computeUnitPriceMicroLamports', true),
  };
  if (!durable) return { ...common, recentBlockhash: pubkey(record.recentBlockhash, 'tx.recentBlockhash'), lastValidBlockHeight: integer(record.lastValidBlockHeight, 'tx.lastValidBlockHeight') };
  const nonce = exact(record.durableNonce, ['nonceAccount', 'nonceAuthority', 'nonceValue'], 'tx.durableNonce');
  const durableNonce = {
    nonceAccount: pubkey(nonce.nonceAccount, 'durableNonce.nonceAccount'),
    nonceAuthority: pubkey(nonce.nonceAuthority, 'durableNonce.nonceAuthority'),
    nonceValue: pubkey(nonce.nonceValue, 'durableNonce.nonceValue'),
  };
  if (durableNonce.nonceAuthority !== wallet) reject('Durable nonce authority must be the treasury wallet');
  return { ...common, durableNonce };
}

/** Validate exact action-specific keys and normalize display strings; no wire parsing or RPC. */
export function assertSolanaIntentShape(value: unknown): SolanaSigningIntent {
  const record = object(value, 'Solana intent');
  exact(record, [...COMMON_FIELDS, ...(record.action === 'swap' ? SWAP_FIELDS : [])], 'Solana intent');
  if (record.version !== '1') reject('Solana intent.version must be "1"');
  const wallet = pubkey(record.wallet, 'intent.wallet');
  const tx = transaction(record.tx, wallet);
  if (typeof record.routeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(record.routeHash)
    || record.routeHash !== computeSolanaRouteHash(tx.serializedMessage)) reject('Solana routeHash must equal SHA-256 of message bytes');
  if (!Array.isArray(record.programIds)) reject('programIds must be a sorted duplicate-free array');
  const programIds = record.programIds.map((entry) => pubkey(entry, 'programIds entry'));
  if (programIds.some((entry, i) => i > 0 && programIds[i - 1] >= entry)) reject('programIds must be sorted and duplicate-free');
  const common: SolanaIntentBase = {
    version: '1', intentId: text(record.intentId, 'intent.intentId'), nonce: decimal(record.nonce, 'intent.nonce'),
    createdAt: integer(record.createdAt, 'intent.createdAt'), expiresAt: integer(record.expiresAt, 'intent.expiresAt'),
    wallet, chainId: cluster(record.chainId), routeHash: record.routeHash, tx,
    tokenIn: token(record.tokenIn, 'tokenIn'), amountIn: decimal(record.amountIn, 'intent.amountIn', true), programIds,
  };
  if (record.action === 'swap') {
    if (record.venue !== 'jupiter-v6') reject('Solana swap venue must be jupiter-v6');
    const slippageBps = integer(record.slippageBps, 'slippageBps', 0, 10000);
    const maxSlippageBps = integer(record.maxSlippageBps, 'maxSlippageBps', 0, 10000);
    if (slippageBps > maxSlippageBps) reject('slippageBps exceeds maxSlippageBps');
    return { ...common, action: 'swap', venue: 'jupiter-v6', tokenOut: token(record.tokenOut, 'tokenOut'),
      minAmountOut: decimal(record.minAmountOut, 'minAmountOut', true), quotedAmountOut: decimal(record.quotedAmountOut, 'quotedAmountOut', true),
      slippageBps, maxSlippageBps, quoteId: text(record.quoteId, 'quoteId'), quotedAt: integer(record.quotedAt, 'quotedAt') };
  }
  if (record.action === 'approve' || record.action === 'revoke') {
    if (record.venue !== 'spl-token') reject('Solana approve/revoke venue must be spl-token');
    if (record.action === 'revoke' && common.amountIn !== '0') reject('Solana revoke amountIn must be zero');
    return { ...common, action: record.action, venue: 'spl-token' };
  }
  if (record.action === 'transfer' && (record.venue === 'spl-token' || record.venue === 'system')) {
    return { ...common, action: 'transfer', venue: record.venue };
  }
  reject('Invalid Solana action/venue pairing');
}

/** Validate an exact Solana approval object without accepting it as authorization. */
export function assertSolanaApprovalShape(value: unknown): VerifierApproval {
  const record = exact(value, APPROVAL_FIELDS, 'Solana approval');
  return {
    intentHash: hex(record.intentHash, 32, 'approval.intentHash'), nonce: decimal(record.nonce, 'approval.nonce'),
    expiresAt: integer(record.expiresAt, 'approval.expiresAt'), verifier: hex(record.verifier, 32, 'approval.verifier'),
    signature: hex(record.signature, 64, 'approval.signature'), decision: decision(record.decision), mode: mode(record.mode),
    signerAddress: pubkey(record.signerAddress, 'approval.signerAddress'),
  };
}

/** Validate a proposal or signed envelope and bind its cluster and treasury to the intent. */
export function assertSolanaRequestShape(value: unknown): SolanaSigningRequest {
  const record = exact(value, ['requestId', 'kind', 'chainId', 'from', 'intent', 'structuredIntent', 'approval'], 'Solana request');
  if (record.kind !== 'transaction') reject('Solana request kind must be transaction');
  const structuredIntent = assertSolanaIntentShape(record.structuredIntent);
  const from = pubkey(record.from, 'request.from');
  const chainId = cluster(record.chainId);
  if (from !== structuredIntent.wallet || chainId !== structuredIntent.chainId) reject('Solana request treasury or cluster does not match intent');
  const approval = record.approval === null ? null : assertSolanaApprovalShape(record.approval);
  if (approval && (approval.signerAddress !== from || approval.nonce !== structuredIntent.nonce || approval.expiresAt !== structuredIntent.expiresAt)) {
    reject('Solana approval treasury, nonce or expiry does not match intent');
  }
  return { requestId: text(record.requestId, 'requestId'), kind: 'transaction', chainId, from,
    intent: text(record.intent, 'request.intent'), structuredIntent, approval };
}

/** Domain-separated verifier bytes. Deny bytes exist for attack modelling only. */
export function solanaApprovalSigningBytes(args: {
  decision: ApprovalDecision; mode: ApprovalMode; signerPubkey: string; cluster: SolanaChainId; intentHash: string;
}): Uint8Array {
  return Buffer.concat([
    Buffer.from(`${SOLANA_APPROVAL_DOMAIN}${decision(args.decision)}\0${mode(args.mode)}\0${pubkey(args.signerPubkey, 'signerPubkey')}\0${cluster(args.cluster)}\0`, 'utf8'),
    Buffer.from(hex(args.intentHash, 32, 'intentHash').slice(2), 'hex'),
  ]);
}
