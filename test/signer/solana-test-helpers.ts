/** Offline PR1 reference code. No production Solana implementation is used here. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';

// Deliberately dynamic: exercise future exports and malformed inputs without a load-time failure.
export function requireFn(mod: object, name: string): (...args: any[]) => any {
  const fn = (mod as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`missing export ${name}`);
  return fn as (...args: any[]) => any;
}
export type RecordValue = Record<string, any>;
export const DOMAIN = 'evalanche-verifier/solana/v1\0';
export const CLUSTERS = ['solana:mainnet', 'solana:devnet'] as const;
export const TIME = 1793012400000;
export const LABELS = {
  verifier: 'evalanche-test-only/solana-vectors/verifier/v1',
  treasuryA: 'evalanche-test-only/solana-vectors/treasury-a/v1',
  treasuryB: 'evalanche-test-only/solana-vectors/treasury-b/v1',
};
export const COMPUTE = 'ComputeBudget111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const WSOL = 'So11111111111111111111111111111111111111112';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const sha256 = (value: string | Uint8Array): Buffer => createHash('sha256').update(value).digest();
export const hex = (value: Uint8Array): string => `0x${Buffer.from(value).toString('hex')}`;
export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
export function base58Decode(value: string): Buffer {
  if (typeof value !== 'string' || !value.length) throw new Error('base58');
  let n = 0n;
  for (const ch of value) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error('base58');
    n = n * 58n + BigInt(digit);
  }
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex');
  return Buffer.concat([Buffer.alloc(value.match(/^1*/)?.[0].length ?? 0), body]);
}
export function publicKey(value: unknown): void {
  if (typeof value !== 'string') throw new Error('pubkey');
  const decoded = base58Decode(value);
  if (decoded.length !== 32 || base58Encode(decoded) !== value) throw new Error('pubkey');
}
export function deriveKey(label: string) {
  const seed = sha256(label);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key);
  const raw = Buffer.from(pub.export({ format: 'jwk' }).x!, 'base64url');
  return { key, pub, raw, publicHex: hex(raw), pubkey: base58Encode(raw), seedHex: hex(seed) };
}
export function caseFlip(value: string): string {
  for (let i = 0; i < value.length; i++) {
    const flipped = value[i] === value[i].toLowerCase() ? value[i].toUpperCase() : value[i].toLowerCase();
    if (flipped !== value[i] && ALPHABET.includes(flipped)) return value.slice(0, i) + flipped + value.slice(i + 1);
  }
  throw new Error('no case variant');
}
export function decodeBase64(value: string): Buffer {
  if (typeof value !== 'string' || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('base64');
  return bytes;
}
/** Synthetic opaque v0-shaped data, NOT a real transaction or a policy/decoder fixture.
 * v0 prefix, header, two static keys, label blockhash, one ComputeBudget CU-limit
 * instruction, zero ALTs. Deliberately not a complete PR3 ComputeBudget policy. */
export function syntheticMessage(label = 'message-a'): Buffer {
  const units = Buffer.alloc(4); units.writeUInt32LE(300000);
  return Buffer.concat([
    Buffer.from([0x80, 1, 0, 1, 2]), deriveKey(LABELS.treasuryA).raw,
    base58Decode(COMPUTE), sha256(`evalanche-test-only/solana-vectors/blockhash/${label}`),
    Buffer.from([1, 1, 0, 5, 2]), units, Buffer.from([0]),
  ]);
}
export function referenceJcs(value: any): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(referenceJcs).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.getOwnPropertyNames(value).sort().map((key) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('prototype');
      return `${referenceJcs(key)}:${referenceJcs(value[key])}`;
    }).join(',')}}`;
  }
  throw new Error('jcs');
}
export const referenceRouteHash = (message: string | Uint8Array): string => hex(sha256(typeof message === 'string' ? decodeBase64(message) : message));
export const referenceIntentHash = (intent: unknown): string => keccak256(toUtf8Bytes(referenceJcs(intent)));
export function makeIntent(action = 'swap', cluster = 'solana:mainnet'): RecordValue {
  const message = syntheticMessage();
  const intent: RecordValue = {
    version: '1', intentId: 'synthetic-pr1', nonce: '1', createdAt: TIME, expiresAt: TIME + 90000,
    wallet: deriveKey(LABELS.treasuryA).pubkey, chainId: cluster,
    venue: action === 'swap' ? 'jupiter-v6' : 'spl-token', action,
    routeHash: referenceRouteHash(message),
    tx: { serializedMessage: message.toString('base64'), recentBlockhash: base58Encode(sha256('evalanche-test-only/solana-vectors/blockhash/message-a')), lastValidBlockHeight: 300000100, computeUnitLimit: 300000, computeUnitPriceMicroLamports: '1000000' },
    tokenIn: { mint: USDC, symbol: 'USDC', decimals: 6 }, amountIn: action === 'revoke' ? '0' : '100000000',
    programIds: [COMPUTE, TOKEN].sort(),
  };
  if (action === 'swap') Object.assign(intent, {
    tokenOut: { mint: WSOL, symbol: 'wSOL', decimals: 9 }, minAmountOut: '495000000', quotedAmountOut: '500000000',
    slippageBps: 100, maxSlippageBps: 100, quoteId: 'synthetic-quote', quotedAt: TIME - 5000,
  });
  return intent;
}
export function makeRequest(intent = makeIntent()): RecordValue {
  return { requestId: 'synthetic-solana', kind: 'transaction', chainId: intent.chainId, from: intent.wallet, intent: 'Synthetic PR1 schema only', structuredIntent: intent, approval: null };
}
export function withMessage(intent: RecordValue, label: string): RecordValue {
  const out = clone(intent); const message = syntheticMessage(label);
  out.tx.serializedMessage = message.toString('base64');
  out.tx.recentBlockhash = base58Encode(sha256(`evalanche-test-only/solana-vectors/blockhash/${label}`));
  out.routeHash = referenceRouteHash(message);
  return out;
}
export function durableIntent(): RecordValue {
  const out = makeIntent();
  delete out.tx.recentBlockhash; delete out.tx.lastValidBlockHeight;
  out.tx.durableNonce = { nonceAccount: deriveKey('evalanche-test-only/nonce-account').pubkey, nonceAuthority: out.wallet, nonceValue: base58Encode(sha256('evalanche-test-only/nonce-value')) };
  return out;
}
const COMMON = ['version', 'intentId', 'nonce', 'createdAt', 'expiresAt', 'wallet', 'chainId', 'venue', 'action', 'routeHash', 'tx', 'tokenIn', 'amountIn', 'programIds'];
export const SWAP_FIELDS = ['tokenOut', 'minAmountOut', 'quotedAmountOut', 'slippageBps', 'maxSlippageBps', 'quoteId', 'quotedAt'];
function exact(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema');
  const own = Object.getOwnPropertyNames(value).sort();
  if (own.join('|') !== [...keys].sort().join('|')) throw new Error('schema');
}
function decimal(value: any): void { if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('schema'); }
function integer(value: any, max = Number.MAX_SAFE_INTEGER, min = 0): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('schema'); }
function text(value: any): void { if (typeof value !== 'string' || !value.length) throw new Error('schema'); }
/** Independent schema oracle for fixture verdicts; no wire parsing, RPC, or economics. */
export function referenceSchema(value: RecordValue): RecordValue {
  exact(value, [...COMMON, ...(value.action === 'swap' ? SWAP_FIELDS : [])]);
  if (value.version !== '1' || !CLUSTERS.includes(value.chainId) || !['swap', 'approve', 'revoke', 'transfer'].includes(value.action)) throw new Error('schema');
  text(value.intentId); decimal(value.nonce); integer(value.createdAt); integer(value.expiresAt); publicKey(value.wallet);
  const venues = value.action === 'swap' ? ['jupiter-v6'] : value.action === 'transfer' ? ['spl-token', 'system'] : ['spl-token'];
  if (!venues.includes(value.venue)) throw new Error('schema');
  const tx = value.tx; const durable = Object.hasOwn(tx, 'durableNonce');
  exact(tx, ['serializedMessage', 'computeUnitLimit', 'computeUnitPriceMicroLamports', ...(durable ? ['durableNonce'] : ['recentBlockhash', 'lastValidBlockHeight'])]);
  decodeBase64(tx.serializedMessage); integer(tx.computeUnitLimit, Number.MAX_SAFE_INTEGER, 1); decimal(tx.computeUnitPriceMicroLamports);
  if (durable) {
    exact(tx.durableNonce, ['nonceAccount', 'nonceAuthority', 'nonceValue']);
    Object.values(tx.durableNonce).forEach(publicKey);
    if (tx.durableNonce.nonceAuthority !== value.wallet) throw new Error('schema');
  } else { publicKey(tx.recentBlockhash); integer(tx.lastValidBlockHeight); }
  if (!/^0x[0-9a-f]{64}$/.test(value.routeHash) || value.routeHash !== referenceRouteHash(tx.serializedMessage)) throw new Error('schema');
  for (const token of [value.tokenIn, ...(value.action === 'swap' ? [value.tokenOut] : [])]) {
    exact(token, ['mint', 'symbol', 'decimals']); publicKey(token.mint); text(token.symbol); integer(token.decimals, 255);
  }
  decimal(value.amountIn);
  if (value.action === 'revoke' && value.amountIn !== '0') throw new Error('schema');
  if (!Array.isArray(value.programIds)) throw new Error('schema');
  value.programIds.forEach(publicKey);
  if (new Set(value.programIds).size !== value.programIds.length || value.programIds.join('|') !== [...value.programIds].sort().join('|')) throw new Error('schema');
  if (value.action === 'swap') {
    decimal(value.minAmountOut); decimal(value.quotedAmountOut); text(value.quoteId); integer(value.quotedAt);
    integer(value.slippageBps, 10000); integer(value.maxSlippageBps, 10000);
    if (value.slippageBps > value.maxSlippageBps) throw new Error('schema');
  }
  return JSON.parse(referenceJcs(value));
}
export interface DomainArgs { decision: string; mode: string; signerPubkey: string; cluster: string; intentHash: string }
/** Raw concatenation is also used to describe intentionally malformed vector inputs. */
export function referenceDomainBytes(args: DomainArgs): Buffer {
  return Buffer.concat([Buffer.from(`${DOMAIN}${args.decision}\0${args.mode}\0${args.signerPubkey}\0${args.cluster}\0`, 'utf8'), Buffer.from(args.intentHash.replace(/^0x/, ''), 'hex')]);
}
export function referenceDomainShape(args: DomainArgs): void {
  if ([args.decision, args.mode, args.signerPubkey, args.cluster, args.intentHash].some((v) => typeof v !== 'string' || v.includes('\0'))) throw new Error('domain');
  if (!['approve', 'deny'].includes(args.decision) || !['live', 'dry-run'].includes(args.mode) || !(CLUSTERS as readonly string[]).includes(args.cluster) || !/^0x[0-9a-fA-F]{64}$/.test(args.intentHash)) throw new Error('domain');
  publicKey(args.signerPubkey);
}
export function referenceSignature(bytes: Uint8Array): string { return hex(sign(null, bytes, deriveKey(LABELS.verifier).key)); }
export function referenceVerify(bytes: Uint8Array, signature: string, verifier: string): boolean {
  try {
    if (!/^0x[0-9a-f]{128}$/.test(signature) || !/^0x[0-9a-f]{64}$/.test(verifier)) return false;
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(verifier.slice(2), 'hex')]), format: 'der', type: 'spki' });
    return verify(null, bytes, pub, Buffer.from(signature.slice(2), 'hex'));
  } catch { return false; }
}
export function referenceApproval(intent = makeIntent(), mode = 'live', decision = 'approve'): RecordValue {
  const intentHash = referenceIntentHash(intent);
  return { intentHash, nonce: intent.nonce, expiresAt: intent.expiresAt, verifier: deriveKey(LABELS.verifier).publicHex,
    signature: referenceSignature(referenceDomainBytes({ decision, mode, signerPubkey: intent.wallet, cluster: intent.chainId, intentHash })), decision, mode, signerAddress: intent.wallet };
}
export function makeEvmIntent(): RecordValue {
  const tx = { to: '0x2222222222222222222222222222222222222222', value: '0', data: '0x', chainId: 43114, nonce: '0', gasLimit: '21000', gasPrice: '1', maxFeePerGas: '0', maxPriorityFeePerGas: '0', type: 0 };
  return { version: '1', intentId: 'evm-pr1-frozen', nonce: '1', createdAt: TIME, expiresAt: TIME + 90000, wallet: '0x1111111111111111111111111111111111111111', chainId: 43114, venue: 'spot', action: 'send', amountIn: '0', routeHash: keccak256(toUtf8Bytes(referenceJcs(tx))), tx };
}
export function referenceEvmBytes(args: { decision: string; mode: string; signerAddress: string; chainId: number; intentHash: string }): Buffer {
  return Buffer.concat([Buffer.from(`evalanche-verifier/v1\0${args.decision}\0${args.mode}\0${args.signerAddress.toLowerCase()}\0${args.chainId}\0`), Buffer.from(args.intentHash.slice(2), 'hex')]);
}
export interface ApprovalVector extends DomainArgs {
  id: string; description: string; structuredIntent: RecordValue; normalizedJcs: string; base64Message: string; routeHash: string;
  domainBytesHex: string; verifier: string; signature: string; family?: 'evm';
  expected: { valid: boolean; error?: string };
}
export function vectorApproval(vector: ApprovalVector): RecordValue {
  return { intentHash: vector.intentHash, nonce: vector.structuredIntent.nonce, expiresAt: vector.structuredIntent.expiresAt,
    verifier: vector.verifier, signature: vector.signature, decision: vector.decision, mode: vector.mode, signerAddress: vector.signerPubkey };
}
export function referenceVectorVerdict(vector: ApprovalVector): { valid: boolean; error?: string } {
  if (vector.family === 'evm') return { valid: referenceVerify(referenceEvmBytes({ ...vector, signerAddress: vector.signerPubkey, chainId: vector.structuredIntent.chainId }), vector.signature, vector.verifier) };
  try { referenceSchema(vector.structuredIntent); } catch { return { valid: false, error: 'schema' }; }
  try { referenceDomainShape(vector); } catch { return { valid: false, error: 'domain' }; }
  if (vector.cluster !== vector.structuredIntent.chainId || vector.signerPubkey !== vector.structuredIntent.wallet) return { valid: false, error: 'binding' };
  if (vector.decision !== 'approve') return { valid: false, error: 'decision' };
  if (!referenceVerify(referenceDomainBytes(vector), vector.signature, vector.verifier)) return { valid: false, error: 'signature' };
  return { valid: true };
}
