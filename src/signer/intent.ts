/**
 * Canonical treasury intents and Ed25519 verifier approvals.
 *
 * The agent builds an intent, hashes it, and asks the verifier (Ops) to sign
 * that hash. The signer recomputes the hash from the transaction it is about
 * to sign and rejects anything that does not match the approval.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, timingSafeEqual } from 'crypto';
import { getBytes, hexlify, keccak256, toUtf8Bytes } from 'ethers';

export interface TokenRef {
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Fields the verifier commits to. `routeHash` is keccak256 of the transaction
 * data (or the message / typed-data payload). `minAmountOut` is the slippage
 * bound and is part of the hashed intent, not of `routeHash` itself.
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
  maxSlippageBps?: number;
  tier?: string;
  sleeve?: string;
  sizePctOfTreasury?: number;
  postFrictionEvUsd?: string;
  signalRefs?: string[];
  routeHash: string;
}

/** Ed25519 approval attached to a signing request. */
export interface VerifierApproval {
  intentHash: string;
  nonce: string;
  expiresAt: number;
  /** Hex-encoded 32-byte Ed25519 public key. */
  verifier: string;
  /** Hex-encoded 64-byte Ed25519 signature over the raw 32-byte intent hash. */
  signature: string;
}

export interface SigningContext {
  /** Human-readable description forwarded to the signer. */
  intent?: string;
  approval?: VerifierApproval;
  structuredIntent?: SigningIntent;
}

export type SigningKind = 'transaction' | 'message' | 'typed-data';

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

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** JSON with recursively sorted object keys and no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Canonical intent JSON. Object keys are sorted at every level. */
export function canonicalIntentJson(intent: SigningIntent): string {
  return canonicalJson(intent);
}

/** keccak256 of the canonical intent JSON, as a 0x-prefixed hex string. */
export function computeIntentHash(intent: SigningIntent): string {
  return keccak256(toUtf8Bytes(canonicalIntentJson(intent)));
}

/**
 * keccak256 of transaction calldata (0x-hex) or, when `data` is not hex,
 * keccak256 of its UTF-8 bytes. Empty calldata hashes as `keccak256(0x)`.
 */
export function computeRouteHash(data: string): string {
  if (typeof data === 'string' && data.startsWith('0x')) return keccak256(data);
  return keccak256(toUtf8Bytes(data ?? ''));
}

/** Payload whose keccak256 is the routeHash for a signing request. */
export function routeMaterial(request: Pick<CanonicalSigningRequest, 'kind' | 'data' | 'message' | 'typedData'>): string {
  if (request.kind === 'transaction') return request.data && request.data.length > 0 ? request.data : '0x';
  if (request.kind === 'message') {
    const message = request.message ?? '';
    return message.startsWith('0x') ? message : hexlify(toUtf8Bytes(message));
  }
  const typed = request.typedData ?? { domain: {}, types: {}, value: {} };
  return hexlify(toUtf8Bytes(canonicalJson({
    domain: typed.domain,
    types: typed.types,
    value: typed.value,
  })));
}

export function computeRequestRouteHash(request: Pick<CanonicalSigningRequest, 'kind' | 'data' | 'message' | 'typedData'>): string {
  return computeRouteHash(routeMaterial(request));
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

function publicKeyObject(publicKeyHex: string) {
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

/** Sign the raw 32-byte intent hash. Returns 0x-hex. */
export function signIntentHash(intentHash: string, privateKeyHex: string, publicKeyHex: string): string {
  const signature = sign(null, Buffer.from(getBytes(intentHash)), privateKeyObject(privateKeyHex, publicKeyHex));
  return hexlify(signature);
}

export function verifyIntentHash(intentHash: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const signature = rawKey(signatureHex, 64, 'Ed25519 signature');
    return verify(null, Buffer.from(getBytes(intentHash)), publicKeyObject(publicKeyHex), signature);
  } catch {
    return false;
  }
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
}): VerifierApproval {
  const intentHash = computeIntentHash(args.intent);
  return {
    intentHash,
    nonce: String(args.intent.nonce),
    expiresAt: Number(args.intent.expiresAt),
    verifier: args.verifierPublicKey,
    signature: signIntentHash(intentHash, args.verifierPrivateKey, args.verifierPublicKey),
  };
}

export const SWAP_ACTIONS = new Set(['swap', 'bridge', 'lifi', 'bridge-swap']);

export function actionRequiresMinAmountOut(action: string): boolean {
  return SWAP_ACTIONS.has(action.trim().toLowerCase());
}
