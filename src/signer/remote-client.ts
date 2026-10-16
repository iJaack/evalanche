/**
 * HTTP(S) and unix-socket client for a remote Evalanche signer.
 *
 * The signed transaction that comes back is decoded and compared to the
 * request. A mismatch is rejected here, before anything is broadcast.
 */

import { request as httpRequest } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Transaction,
  getAddress,
  hexlify,
  verifyMessage,
  verifyTypedData,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import {
  computeRequestRouteHash,
  type CanonicalSigningRequest,
  type RemoteSignerConfig,
  type SigningContext,
  type SigningKind,
  type SigningProvider,
  type SigningResult,
  type TypedDataPayload,
} from './intent';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_ENV = 'EVALANCHE_SIGNER_TOKEN';
const MAX_RESPONSE_BYTES = 128 * 1024;

function tokenFromConfig(config: RemoteSignerConfig): string {
  if (typeof config.token === 'string' && config.token.length > 0) return config.token;
  const envName = config.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const value = process.env[envName];
  if (!value) {
    throw new EvalancheError(
      `Remote signer bearer token is missing. Set ${envName} or pass token in RemoteSignerConfig.`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  return value;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EvalancheError(`Remote signer URL is invalid: ${url}`, EvalancheErrorCode.INVALID_CONFIG);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EvalancheError(
      `Remote signer URL must be http or https, got ${parsed.protocol}`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return hexlify(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = jsonSafe(entry);
    }
    return out;
  }
  return value;
}

function qty(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return BigInt(value as bigint | number | string).toString();
}

function dataOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return hexlify(value);
  return undefined;
}

function sameHex(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? '0x').toLowerCase() === (right ?? '0x').toLowerCase();
}

function sameAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return getAddress(left) === getAddress(right);
}

function bigintEqual(actual: bigint | null | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return actual === undefined || actual === null;
  return (actual ?? 0n) === BigInt(expected);
}

/**
 * Decode a signed transaction and require every requested field to match.
 * Fields the request omitted must be absent on the decoded transaction.
 */
export function assertSignedTransactionMatches(signedHex: string, request: CanonicalSigningRequest): void {
  let decoded: Transaction;
  try {
    decoded = Transaction.from(signedHex);
  } catch (error) {
    throw new EvalancheError(
      'Remote signer returned a transaction that could not be decoded',
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
      error instanceof Error ? error : undefined,
    );
  }

  const mismatches: string[] = [];
  if (Number(decoded.chainId) !== Number(request.chainId)) mismatches.push('chainId');
  if (!decoded.from || !sameAddress(decoded.from, request.from)) mismatches.push('from');
  if (!sameAddress(decoded.to, request.to ?? null)) mismatches.push('to');
  if ((decoded.value ?? 0n) !== BigInt(request.value ?? '0')) mismatches.push('value');
  if (!sameHex(decoded.data, request.data ?? '0x')) mismatches.push('data');
  if (request.nonce !== undefined && decoded.nonce !== request.nonce) mismatches.push('nonce');
  if (!bigintEqual(decoded.gasLimit, request.gasLimit)) mismatches.push('gasLimit');
  if (!bigintEqual(decoded.gasPrice, request.gasPrice)) mismatches.push('gasPrice');
  if (!bigintEqual(decoded.maxFeePerGas, request.maxFeePerGas)) mismatches.push('maxFeePerGas');
  if (!bigintEqual(decoded.maxPriorityFeePerGas, request.maxPriorityFeePerGas)) mismatches.push('maxPriorityFeePerGas');
  if (request.type !== undefined && decoded.type !== request.type) mismatches.push('type');

  if (mismatches.length > 0) {
    throw new EvalancheError(
      `Decoded signed transaction does not match the requested fields: ${mismatches.join(', ')}`,
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
    );
  }
}

function assertSignatureMatches(request: CanonicalSigningRequest, signature: string): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new EvalancheError(
      'Remote signer returned a signature that is not a 65-byte hex string',
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
    );
  }
  try {
    const recovered = request.kind === 'message'
      ? verifyMessage(request.message ?? '', signature)
      : verifyTypedData(
        request.typedData?.domain as TypedDataDomain,
        request.typedData?.types as Record<string, TypedDataField[]>,
        request.typedData?.value ?? {},
        signature,
      );
    if (!sameAddress(recovered, request.from)) {
      throw new EvalancheError(
        'Remote signer signature does not recover to the requested from address',
        EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
      );
    }
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    throw new EvalancheError(
      'Remote signer signature could not be verified',
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
      error instanceof Error ? error : undefined,
    );
  }
}

export function assertSigningResult(request: CanonicalSigningRequest, result: SigningResult): void {
  if (result.requestId !== request.requestId) {
    throw new EvalancheError(
      'Remote signer response requestId does not match the request',
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
    );
  }
  if (result.dryRun) {
    throw new EvalancheError(
      'Remote signer is in dry-run mode and did not return a signature',
      EvalancheErrorCode.SIGNER_REJECTED,
    );
  }
  if (request.kind === 'transaction') {
    if (!result.signedTransaction) {
      throw new EvalancheError(
        'Remote signer did not return a signed transaction',
        EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
      );
    }
    assertSignedTransactionMatches(result.signedTransaction, request);
    return;
  }
  if (!result.signature) {
    throw new EvalancheError(
      'Remote signer did not return a signature',
      EvalancheErrorCode.SIGNER_RESPONSE_INVALID,
    );
  }
  assertSignatureMatches(request, result.signature);
}

function mapServerError(status: number, body: string): EvalancheError {
  let message = body.slice(0, 500);
  let code = EvalancheErrorCode.SIGNER_REJECTED;
  try {
    const parsed = JSON.parse(body) as { error?: string; code?: string };
    if (parsed.error) message = parsed.error;
    if (parsed.code && parsed.code in EvalancheErrorCode) {
      code = EvalancheErrorCode[parsed.code as keyof typeof EvalancheErrorCode];
    }
  } catch {
    // Keep the raw body snippet.
  }
  if (status === 401) code = EvalancheErrorCode.INVALID_CONFIG;
  return new EvalancheError(`Remote signer rejected the request (${status}): ${message}`, code);
}

async function postJson(config: RemoteSignerConfig, body: string, token: string, requestId: string): Promise<string> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-request-id': requestId,
  };

  if (config.socketPath) {
    return postUnix(config.socketPath, body, headers, timeoutMs);
  }
  if (!config.url) {
    throw new EvalancheError(
      'Remote signer config needs url or socketPath',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  assertHttpUrl(config.url);
  let response: Response;
  try {
    response = await fetch(new URL('/v1/sign', config.url), {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new EvalancheError('Remote signer request timed out', EvalancheErrorCode.TIMEOUT);
    }
    throw new EvalancheError(
      `Remote signer request failed: ${error instanceof Error ? error.message : String(error)}`,
      EvalancheErrorCode.NETWORK_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new EvalancheError('Remote signer response is too large', EvalancheErrorCode.SIGNER_RESPONSE_INVALID);
  }
  if (!response.ok) throw mapServerError(response.status, text);
  return text;
}

function postUnix(socketPath: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      path: '/v1/sign',
      method: 'POST',
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new EvalancheError('Remote signer response is too large', EvalancheErrorCode.SIGNER_RESPONSE_INVALID));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) {
          reject(mapServerError(res.statusCode ?? 500, text));
          return;
        }
        resolve(text);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new EvalancheError('Remote signer request timed out', EvalancheErrorCode.TIMEOUT));
    });
    req.on('error', (error) => {
      reject(new EvalancheError(
        `Remote signer request failed: ${error.message}`,
        EvalancheErrorCode.NETWORK_ERROR,
        error,
      ));
    });
    req.end(body);
  });
}

function parseResult(request: CanonicalSigningRequest, text: string): SigningResult {
  let parsed: SigningResult;
  try {
    parsed = JSON.parse(text) as SigningResult;
  } catch {
    throw new EvalancheError('Remote signer returned invalid JSON', EvalancheErrorCode.SIGNER_RESPONSE_INVALID);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.requestId !== 'string') {
    throw new EvalancheError('Remote signer response is missing requestId', EvalancheErrorCode.SIGNER_RESPONSE_INVALID);
  }
  assertSigningResult(request, parsed);
  return parsed;
}

export class RemoteSignerClient implements SigningProvider {
  readonly kind = 'signing-provider' as const;
  readonly address: string;
  private readonly config: RemoteSignerConfig;

  constructor(config: RemoteSignerConfig) {
    if (!config.address) {
      throw new EvalancheError('Remote signer config requires address', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (!config.url && !config.socketPath) {
      throw new EvalancheError('Remote signer config requires url or socketPath', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (config.url) assertHttpUrl(config.url);
    this.address = getAddress(config.address);
    this.config = config;
  }

  async signTransaction(request: CanonicalSigningRequest): Promise<SigningResult> {
    return this.post({ ...request, kind: 'transaction' });
  }

  async signMessage(request: CanonicalSigningRequest): Promise<SigningResult> {
    return this.post({ ...request, kind: 'message' });
  }

  async signTypedData(request: CanonicalSigningRequest): Promise<SigningResult> {
    return this.post({ ...request, kind: 'typed-data' });
  }

  private async post(request: CanonicalSigningRequest): Promise<SigningResult> {
    const token = tokenFromConfig(this.config);
    const body = JSON.stringify(request);
    const text = await postJson(this.config, body, token, request.requestId);
    return parseResult(request, text);
  }
}

export function bearerEquals(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function buildCanonicalRequest(args: {
  kind: SigningKind;
  chainId: number;
  from: string;
  intent: string;
  context?: SigningContext | null;
  tx?: TransactionRequest;
  message?: string | Uint8Array;
  typedData?: TypedDataPayload;
}): CanonicalSigningRequest {
  const tx = args.tx ?? {};
  const chainId = tx.chainId === undefined || tx.chainId === null ? args.chainId : Number(tx.chainId);
  const message = args.message === undefined
    ? undefined
    : typeof args.message === 'string'
      ? args.message
      : hexlify(args.message);
  const typedData = args.typedData
    ? jsonSafe(args.typedData) as TypedDataPayload
    : undefined;
  const request: CanonicalSigningRequest = {
    requestId: randomUUID(),
    kind: args.kind,
    chainId,
    from: getAddress(args.from),
    to: tx.to ? getAddress(String(tx.to)) : args.kind === 'transaction' ? null : undefined,
    value: args.kind === 'transaction' ? (qty(tx.value) ?? '0') : undefined,
    data: args.kind === 'transaction' ? (dataOf(tx.data) ?? '0x') : undefined,
    gasLimit: qty(tx.gasLimit),
    gasPrice: qty(tx.gasPrice),
    maxFeePerGas: qty(tx.maxFeePerGas),
    maxPriorityFeePerGas: qty(tx.maxPriorityFeePerGas),
    nonce: tx.nonce === undefined || tx.nonce === null ? undefined : Number(tx.nonce),
    type: tx.type === undefined || tx.type === null ? undefined : Number(tx.type),
    intent: args.context?.intent?.trim()
      || args.intent,
    structuredIntent: args.context?.structuredIntent,
    approval: args.context?.approval,
    message,
    typedData,
  };
  if (args.context?.structuredIntent && !args.context.structuredIntent.routeHash) {
    request.structuredIntent = {
      ...args.context.structuredIntent,
      routeHash: computeRequestRouteHash(request),
    };
  }
  return request;
}
