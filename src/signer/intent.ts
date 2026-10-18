/**
 * Canonical treasury intents and Ed25519 verifier approvals.
 *
 * The verifier signs a domain-separated approval, not the raw intent hash.
 * The intent carries the exact transaction object. The signer decodes only
 * known calldata and denies every path it cannot decode.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, timingSafeEqual } from 'crypto';
import { getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';
import { ed25519PointError, ed25519SignatureError } from './ed25519';
import { canonicalJson } from './jcs';

export interface TokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Transaction fields the verifier commits to. Every value is matched exactly
 * before the signer produces a signature. `gasPrice` is included so a legacy
 * transaction cannot move its fee out of the hashed object.
 */
export interface ApprovedTransaction {
  to: string;
  value: string;
  data: string;
  chainId: number;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  gasPrice: string;
  type: number;
}

/**
 * Fields the verifier commits to. `routeHash` commits to the approved
 * transaction object, or to the UTF-8 message / typed-data payload.
 * `minAmountOut` is the slippage bound. A Li.Fi V3 swap requires
 * `quotedAmountOut`, the quoted bought amount. minOut must cover that quote
 * after slippage, and the quote must leave a positive token-unit floor. Money
 * fields and `nonce` are decimal strings. `maxSlippageBps` is an integer.
 */
export interface SigningIntent {
  version: string;
  intentId: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  wallet: string;
  chainId: number;
  venue: string;
  action: string;
  tokenIn?: TokenRef;
  tokenOut?: TokenRef;
  amountIn?: string;
  minAmountOut?: string;
  /** Quoted bought amount. Required for a Li.Fi V3 swap. */
  quotedAmountOut?: string;
  maxSlippageBps?: number;
  tier?: string;
  sleeve?: string;
  sizePctOfTreasury?: number;
  postFrictionEvUsd?: string;
  signalRefs?: string[];
  routeHash: string;
  tx?: ApprovedTransaction;
  /**
   * Polymarket order fields. Present only for kind `polymarket-order`.
   * `orderType` is FOK. expiration, nonce, feeRateBps, and taker are not
   * signed by the exchange, so this object cannot make them enforceable.
   */
  polymarket?: {
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
    balance?: string;
    navUsd: string;
    marketOpenUsd: string;
    totalOpenUsd: string;
    perOrderPctNav?: number;
    perMarketPctNav?: number;
    totalOpenPctNav?: number;
  };
  /** Treasury-owned Uniswap v3 position token ids, checked by the verifier. */
  clmm?: {
    ownedTokenIds: string[];
  };
}

export type ApprovalDecision = 'approve' | 'deny';
export type ApprovalMode = 'dry-run' | 'live';

/**
 * Ed25519 approval. The signature covers
 * `evalanche-verifier/v1\0 || decision || mode || signerAddress || chainId || intentHash`.
 * Only `decision=approve` is accepted, and `mode` must match the signer process.
 */
export interface VerifierApproval {
  intentHash: string;
  nonce: string;
  expiresAt: number;
  /** Hex-encoded 32-byte Ed25519 public key. */
  verifier: string;
  /** Hex-encoded 64-byte Ed25519 signature over the domain-separated approval bytes. */
  signature: string;
  decision: ApprovalDecision;
  mode: ApprovalMode;
  signerAddress: string;
}

export interface SigningContext {
  /** Human-readable description forwarded to the signer. */
  intent?: string;
  approval?: VerifierApproval;
  structuredIntent?: SigningIntent;
}

export type SigningKind = 'transaction' | 'message' | 'typed-data' | 'polymarket-order' | 'clob-auth';

export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  value: Record<string, unknown>;
}

/** Canonical request posted to a remote signer. */
export interface CanonicalSigningRequest {
  requestId: string;
  kind: SigningKind;
  chainId: number;
  from: string;
  to?: string | null;
  value?: string;
  data?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: number;
  type?: number;
  intent: string;
  structuredIntent?: SigningIntent;
  approval?: VerifierApproval;
  message?: string;
  typedData?: TypedDataPayload;
}

export interface SigningResult {
  requestId: string;
  signature?: string;
  signedTransaction?: string;
  dryRun?: boolean;
  decision?: 'allow' | 'deny';
}

/**
 * HTTP(S) or unix-socket signer. `token` wins over `tokenEnv`.
 * The default env var is `EVALANCHE_SIGNER_TOKEN`.
 */
export interface RemoteSignerConfig {
  url?: string;
  socketPath?: string;
  address: string;
  token?: string;
  tokenEnv?: string;
  timeoutMs?: number;
}

/** Pluggable signer. Local adapters and the HTTP client both implement this. */
export interface SigningProvider {
  readonly kind: 'signing-provider';
  readonly address: string;
  signTransaction(request: CanonicalSigningRequest): Promise<SigningResult>;
  signMessage(request: CanonicalSigningRequest): Promise<SigningResult>;
  signTypedData(request: CanonicalSigningRequest): Promise<SigningResult>;
}

export function isSigningProvider(value: unknown): value is SigningProvider {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SigningProvider>;
  return record.kind === 'signing-provider'
    && typeof record.signTransaction === 'function'
    && typeof record.signMessage === 'function'
    && typeof record.signTypedData === 'function';
}

export function isRemoteSignerConfig(value: unknown): value is RemoteSignerConfig {
  if (!value || typeof value !== 'object') return false;
  if (isSigningProvider(value)) return false;
  const record = value as Partial<RemoteSignerConfig> & { signTransaction?: unknown; privateKey?: unknown };
  if (typeof record.signTransaction === 'function') return false;
  if (typeof record.privateKey === 'string') return false;
  const hasEndpoint = typeof record.url === 'string' || typeof record.socketPath === 'string';
  return hasEndpoint && typeof record.address === 'string';
}

export { canonicalJson } from './jcs';

const INTENT_FIELDS = [
  'version', 'intentId', 'nonce', 'createdAt', 'expiresAt', 'wallet', 'chainId', 'venue', 'action',
  'tokenIn', 'tokenOut', 'amountIn', 'minAmountOut', 'quotedAmountOut', 'maxSlippageBps', 'tier', 'sleeve',
  'sizePctOfTreasury', 'postFrictionEvUsd', 'signalRefs', 'routeHash', 'tx', 'polymarket', 'clmm',
] as const;

const TOKEN_FIELDS = ['address', 'symbol', 'decimals'] as const;
const TX_FIELDS = [
  'to', 'value', 'data', 'chainId', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice', 'type',
] as const;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function reject(message: string): never {
  throw new Error(message);
}

function ownKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Expected an object');
  return Object.getOwnPropertyNames(value as object);
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const keys = ownKeys(value);
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      reject(`Forbidden key ${key}`);
    }
    if (!allowed.includes(key)) reject(`${label} has unknown field ${key}`);
  }
  return value as Record<string, unknown>;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    reject(`${label} must be a decimal string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) reject(`${label} must be an integer`);
  return value;
}

function nfc(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) reject(`${label} must be a string`);
  return value.normalize('NFC');
}

function tokenRef(value: unknown, label: string): TokenRef {
  const record = assertExactKeys(value, TOKEN_FIELDS, label);
  for (const field of TOKEN_FIELDS) {
    if (!(field in record)) reject(`${label}.${field} is required`);
  }
  let address: string;
  try {
    address = getAddress(String(record.address));
  } catch {
    reject(`${label}.address is not an address`);
  }
  const decimals = integer(record.decimals, `${label}.decimals`);
  if (decimals < 0 || decimals > 255) reject(`${label}.decimals is out of range`);
  return { address, symbol: nfc(record.symbol, `${label}.symbol`), decimals };
}

export function normalizeApprovedTx(tx: ApprovedTransaction): ApprovedTransaction {
  let to: string;
  try {
    to = getAddress(tx.to);
  } catch {
    reject('tx.to is not an address');
  }
  const data = tx.data.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(data) || data.length % 2 !== 0) reject('tx.data must be even-length hex');
  return {
    to,
    value: decimal(tx.value, 'tx.value'),
    data,
    chainId: integer(tx.chainId, 'tx.chainId'),
    nonce: decimal(tx.nonce, 'tx.nonce'),
    gasLimit: decimal(tx.gasLimit, 'tx.gasLimit'),
    maxFeePerGas: decimal(tx.maxFeePerGas, 'tx.maxFeePerGas'),
    maxPriorityFeePerGas: decimal(tx.maxPriorityFeePerGas, 'tx.maxPriorityFeePerGas'),
    gasPrice: decimal(tx.gasPrice, 'tx.gasPrice'),
    type: integer(tx.type, 'tx.type'),
  };
}

/** Reject extra keys, non-canonical numbers, and prototype keys. Returns the normalized intent. */
export function assertIntentShape(value: unknown): SigningIntent {
  const record = assertExactKeys(value, INTENT_FIELDS, 'intent');
  if (record.version !== '1') reject('intent.version must be "1"');
  const intent: SigningIntent = {
    version: '1',
    intentId: nfc(record.intentId, 'intent.intentId'),
    nonce: decimal(record.nonce, 'intent.nonce'),
    createdAt: integer(record.createdAt, 'intent.createdAt'),
    expiresAt: integer(record.expiresAt, 'intent.expiresAt'),
    wallet: '',
    chainId: integer(record.chainId, 'intent.chainId'),
    venue: nfc(record.venue, 'intent.venue'),
    action: nfc(record.action, 'intent.action'),
    routeHash: nfc(record.routeHash, 'intent.routeHash'),
  };
  try {
    intent.wallet = getAddress(String(record.wallet));
  } catch {
    reject('intent.wallet is not an address');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(intent.routeHash)) reject('intent.routeHash must be a 32-byte hex hash');
  if (record.tokenIn !== undefined) intent.tokenIn = tokenRef(record.tokenIn, 'tokenIn');
  if (record.tokenOut !== undefined) intent.tokenOut = tokenRef(record.tokenOut, 'tokenOut');
  if (record.amountIn !== undefined) intent.amountIn = decimal(record.amountIn, 'intent.amountIn');
  if (record.minAmountOut !== undefined) intent.minAmountOut = decimal(record.minAmountOut, 'intent.minAmountOut');
  if (record.quotedAmountOut !== undefined) intent.quotedAmountOut = decimal(record.quotedAmountOut, 'intent.quotedAmountOut');
  if (record.maxSlippageBps !== undefined) {
    const bps = integer(record.maxSlippageBps, 'intent.maxSlippageBps');
    if (bps < 0) reject('intent.maxSlippageBps must be a non-negative integer');
    intent.maxSlippageBps = bps;
  }
  if (record.tier !== undefined) intent.tier = nfc(record.tier, 'intent.tier');
  if (record.sleeve !== undefined) intent.sleeve = nfc(record.sleeve, 'intent.sleeve');
  if (record.sizePctOfTreasury !== undefined) {
    const size = integer(record.sizePctOfTreasury, 'intent.sizePctOfTreasury');
    if (size < 0) reject('intent.sizePctOfTreasury must be a non-negative integer');
    intent.sizePctOfTreasury = size;
  }
  if (record.postFrictionEvUsd !== undefined) intent.postFrictionEvUsd = decimal(record.postFrictionEvUsd, 'intent.postFrictionEvUsd');
  if (record.signalRefs !== undefined) {
    if (!Array.isArray(record.signalRefs)) reject('intent.signalRefs must be an array');
    intent.signalRefs = record.signalRefs.map((entry, index) => nfc(entry, `intent.signalRefs[${index}]`));
  }
  if (record.tx !== undefined) {
    assertExactKeys(record.tx, TX_FIELDS, 'tx');
    intent.tx = normalizeApprovedTx(record.tx as ApprovedTransaction);
    if (intent.tx.chainId !== intent.chainId) reject('tx.chainId does not match intent.chainId');
  }
  if (record.polymarket !== undefined) intent.polymarket = polymarketOrder(record.polymarket);
  if (record.clmm !== undefined) intent.clmm = clmmOwned(record.clmm);
  return intent;
}

const POLYMARKET_INTENT_FIELDS = [
  'conditionId', 'tokenId', 'outcome', 'side', 'limitPrice', 'size', 'notionalUsd', 'orderType',
  'negRisk', 'verifyingContract', 'mid', 'balance', 'navUsd', 'marketOpenUsd', 'totalOpenUsd',
  'perOrderPctNav', 'perMarketPctNav', 'totalOpenPctNav',
] as const;

function polymarketOrder(value: unknown): NonNullable<SigningIntent['polymarket']> {
  const record = assertExactKeys(value, POLYMARKET_INTENT_FIELDS, 'polymarket');
  if (typeof record.negRisk !== 'boolean') reject('polymarket.negRisk must be boolean');
  if (record.side !== 'BUY' && record.side !== 'SELL') reject('polymarket.side must be BUY or SELL');
  let verifyingContract: string;
  try {
    verifyingContract = getAddress(String(record.verifyingContract));
  } catch {
    reject('polymarket.verifyingContract is not an address');
  }
  const order: NonNullable<SigningIntent['polymarket']> = {
    conditionId: nfc(record.conditionId, 'polymarket.conditionId'),
    tokenId: decimal(record.tokenId, 'polymarket.tokenId'),
    outcome: nfc(record.outcome, 'polymarket.outcome'),
    side: record.side,
    limitPrice: nfc(record.limitPrice, 'polymarket.limitPrice'),
    size: decimal(record.size, 'polymarket.size'),
    notionalUsd: nfc(record.notionalUsd, 'polymarket.notionalUsd'),
    orderType: nfc(record.orderType, 'polymarket.orderType'),
    negRisk: record.negRisk,
    verifyingContract,
    mid: nfc(record.mid, 'polymarket.mid'),
    navUsd: nfc(record.navUsd, 'polymarket.navUsd'),
    marketOpenUsd: nfc(record.marketOpenUsd, 'polymarket.marketOpenUsd'),
    totalOpenUsd: nfc(record.totalOpenUsd, 'polymarket.totalOpenUsd'),
  };
  if (record.balance !== undefined) order.balance = decimal(record.balance, 'polymarket.balance');
  for (const name of ['perOrderPctNav', 'perMarketPctNav', 'totalOpenPctNav'] as const) {
    if (record[name] === undefined) continue;
    const pct = integer(record[name], `polymarket.${name}`);
    if (pct < 0) reject(`polymarket.${name} must be a non-negative integer`);
    order[name] = pct;
  }
  return order;
}

function clmmOwned(value: unknown): NonNullable<SigningIntent['clmm']> {
  const record = assertExactKeys(value, ['ownedTokenIds'], 'clmm');
  if (!Array.isArray(record.ownedTokenIds)) reject('clmm.ownedTokenIds must be an array');
  return {
    ownedTokenIds: record.ownedTokenIds.map((entry, index) => decimal(entry, `clmm.ownedTokenIds[${index}]`)),
  };
}

/** Canonical intent JSON. Object keys are sorted at every level. */
export function canonicalIntentJson(intent: SigningIntent): string {
  return canonicalJson(assertIntentShape(intent));
}

/** keccak256 of the canonical intent JSON, as a 0x-prefixed hex string. */
export function computeIntentHash(intent: SigningIntent): string {
  return keccak256(toUtf8Bytes(canonicalIntentJson(intent)));
}

/** keccak256 of the canonical approved transaction object. */
export function computeApprovedTxHash(tx: ApprovedTransaction): string {
  return keccak256(toUtf8Bytes(canonicalJson(normalizeApprovedTx(tx))));
}

/**
 * keccak256 of a message as UTF-8. A 0x prefix is not treated as hex, so
 * the string "x" and the string "0x78" hash differently.
 */
export function computeMessageRouteHash(message: string): string {
  return keccak256(toUtf8Bytes(message.normalize('NFC')));
}

export function computeTypedDataRouteHash(typed: TypedDataPayload): string {
  return keccak256(toUtf8Bytes(canonicalJson({
    domain: typed.domain,
    types: typed.types,
    value: typed.value,
  })));
}

/** @deprecated Calldata-only hash. Transaction approvals use computeApprovedTxHash. */
export function computeRouteHash(data: string): string {
  if (typeof data === 'string' && data.startsWith('0x')) return keccak256(data);
  return keccak256(toUtf8Bytes(data ?? ''));
}

type RouteRequest = Pick<CanonicalSigningRequest, 'kind' | 'data' | 'message' | 'typedData' | 'to' | 'value' | 'chainId' | 'nonce' | 'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice' | 'type'>;

/** Payload whose keccak256 is the routeHash for a signing request. */
export function routeMaterial(request: RouteRequest): string {
  if (request.kind === 'polymarket-order' || request.kind === 'clob-auth' || request.kind === 'typed-data') {
    const typed = request.typedData ?? { domain: {}, types: {}, value: {} };
    return canonicalJson({ domain: typed.domain, types: typed.types, value: typed.value });
  }
  if (request.kind === 'transaction') {
    return canonicalJson(normalizeApprovedTx({
      to: request.to ?? '',
      value: request.value ?? '0',
      data: request.data && request.data.length > 0 ? request.data : '0x',
      chainId: Number(request.chainId),
      nonce: String(request.nonce ?? 0),
      gasLimit: request.gasLimit ?? '0',
      maxFeePerGas: request.maxFeePerGas ?? '0',
      maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? '0',
      gasPrice: request.gasPrice ?? '0',
      type: request.type ?? 0,
    }));
  }
  if (request.kind === 'message') return request.message ?? '';
  const typed = request.typedData ?? { domain: {}, types: {}, value: {} };
  return canonicalJson({ domain: typed.domain, types: typed.types, value: typed.value });
}

export function computeRequestRouteHash(request: RouteRequest): string {
  if (request.kind === 'message') return computeMessageRouteHash(request.message ?? '');
  if (request.kind === 'typed-data' || request.kind === 'polymarket-order' || request.kind === 'clob-auth') {
    const typed = request.typedData ?? { domain: {}, types: {}, value: {} };
    return computeTypedDataRouteHash(typed);
  }
  return computeApprovedTxHash({
    to: request.to ?? '',
    value: request.value ?? '0',
    data: request.data && request.data.length > 0 ? request.data : '0x',
    chainId: Number(request.chainId),
    nonce: String(request.nonce ?? 0),
    gasLimit: request.gasLimit ?? '0',
    maxFeePerGas: request.maxFeePerGas ?? '0',
    maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? '0',
    gasPrice: request.gasPrice ?? '0',
    type: request.type ?? 0,
  });
}

export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

function strip0x(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

function rawKey(hex: string, expectedBytes: number, label: string): Buffer {
  const raw = Buffer.from(strip0x(hex), 'hex');
  if (raw.length !== expectedBytes) {
    throw new Error(`${label} must be ${expectedBytes} bytes`);
  }
  return raw;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return {
    publicKey: hexlify(Buffer.from(pubJwk.x, 'base64url')),
    privateKey: hexlify(Buffer.from(privJwk.d, 'base64url')),
  };
}

export function assertEd25519PublicKey(publicKeyHex: string): void {
  const raw = rawKey(publicKeyHex, 32, 'Ed25519 public key');
  const problem = ed25519PointError(raw);
  if (problem) throw new Error(`Verifier public key is rejected: ${problem}`);
}

function publicKeyObject(publicKeyHex: string) {
  assertEd25519PublicKey(publicKeyHex);
  const raw = rawKey(publicKeyHex, 32, 'Ed25519 public key');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function privateKeyObject(privateKeyHex: string, publicKeyHex: string) {
  const secret = rawKey(privateKeyHex, 32, 'Ed25519 private key');
  const pub = rawKey(publicKeyHex, 32, 'Ed25519 public key');
  return createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: secret.toString('base64url'),
      x: pub.toString('base64url'),
    },
    format: 'jwk',
  });
}

/** Sign arbitrary bytes. `signIntentHash` still signs only the raw hash and is not an approval. */
export function signIntentHash(intentHash: string, privateKeyHex: string, publicKeyHex: string): string {
  return signBytes(getBytes(intentHash), privateKeyHex, publicKeyHex);
}

export function signBytes(message: Uint8Array, privateKeyHex: string, publicKeyHex: string): string {
  const signature = sign(null, Buffer.from(message), privateKeyObject(privateKeyHex, publicKeyHex));
  return hexlify(signature);
}

export function verifyBytes(message: Uint8Array, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const signature = rawKey(signatureHex, 64, 'Ed25519 signature');
    const signatureProblem = ed25519SignatureError(signature);
    if (signatureProblem) return false;
    assertEd25519PublicKey(publicKeyHex);
    return verify(null, Buffer.from(message), publicKeyObject(publicKeyHex), signature);
  } catch {
    return false;
  }
}

export function verifyIntentHash(intentHash: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    return verifyBytes(getBytes(intentHash), signatureHex, publicKeyHex);
  } catch {
    return false;
  }
}

/**
 * Bytes the verifier signs. Layout:
 * "evalanche-verifier/v1\0" || decision || "\0" || mode || "\0" || signerAddress || "\0" || chainId || "\0" || intentHash
 */
export function approvalSigningBytes(args: {
  decision: ApprovalDecision;
  mode: ApprovalMode;
  signerAddress: string;
  chainId: number;
  intentHash: string;
}): Uint8Array {
  const address = getAddress(args.signerAddress).toLowerCase();
  const hash = args.intentHash.startsWith('0x') ? args.intentHash.slice(2) : args.intentHash;
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) reject('intentHash must be 32 bytes');
  return Buffer.concat([
    Buffer.from('evalanche-verifier/v1\0', 'utf8'),
    Buffer.from(args.decision, 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(args.mode, 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(address, 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(String(args.chainId), 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(hash, 'hex'),
  ]);
}

export function keysEqual(leftHex: string, rightHex: string): boolean {
  try {
    const left = rawKey(leftHex, 32, 'key');
    const right = rawKey(rightHex, 32, 'key');
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function signVerifierApproval(args: {
  intent: SigningIntent;
  verifierPrivateKey: string;
  verifierPublicKey: string;
  decision?: ApprovalDecision;
  mode?: ApprovalMode;
  signerAddress?: string;
}): VerifierApproval {
  const intent = assertIntentShape(args.intent);
  const decision = args.decision ?? 'approve';
  const mode = args.mode ?? 'live';
  const signerAddress = getAddress(args.signerAddress ?? intent.wallet);
  const intentHash = computeIntentHash(intent);
  const message = approvalSigningBytes({
    decision,
    mode,
    signerAddress,
    chainId: intent.chainId,
    intentHash,
  });
  return {
    intentHash,
    nonce: intent.nonce,
    expiresAt: intent.expiresAt,
    verifier: args.verifierPublicKey,
    signature: signBytes(message, args.verifierPrivateKey, args.verifierPublicKey),
    decision,
    mode,
    signerAddress,
  };
}

export const SWAP_ACTIONS = new Set(['swap', 'bridge', 'lifi', 'bridge-swap']);

export function actionRequiresMinAmountOut(action: string): boolean {
  return SWAP_ACTIONS.has(action.trim().toLowerCase());
}
