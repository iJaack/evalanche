/**
 * Reference signer. The private key lives only in this process.
 *
 * Before a signature is produced the server checks the pinned Ed25519
 * verifier, recomputes the intent hash from the transaction, enforces a
 * monotonic single-use nonce and expiry, applies the deny list and the
 * spending policy, caps token amounts, and simulates. Dry-run does all of
 * that and then stops.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, rename, appendFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { JsonRpcProvider, Wallet, getAddress, type TransactionRequest } from 'ethers';
import type { HDNodeWallet } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { PolicyEngine } from '../economy/policies';
import { simulateTransaction, type SimulationResult } from '../economy/simulation';
import type { PendingTransaction, SpendingPolicy } from '../economy/types';
import {
  actionRequiresMinAmountOut,
  computeIntentHash,
  computeRequestRouteHash,
  keysEqual,
  verifyIntentHash,
  type CanonicalSigningRequest,
  type SigningIntent,
  type SigningResult,
  type VerifierApproval,
} from './intent';
import { bearerEquals } from './remote-client';

const APPROVE_SELECTOR = '0x095ea7b3';
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const DEFAULT_VENUE_ACTIONS = [
  'hyperliquid:order',
  'hyperliquid:placeorder',
  'hyperliquid:marketorder',
  'hyperliquid:limitorder',
  'hyperliquid:cancel',
  'hyperliquid:modify',
  'hyperliquid:cancelorder',
  'hyperliquid:batchmodify',
];

export interface DenyListConfig {
  selectors?: string[];
  contracts?: string[];
  venueActions?: string[];
  /** When false, the Hyperliquid order-tool defaults are not included. */
  useDefaults?: boolean;
}

export interface SignerServerOptions {
  /** In-memory key for tests and embedded hosts. Mutually exclusive with keystorePath. */
  privateKey?: string;
  keystorePath?: string;
  keystorePasswordEnv?: string;
  verifierPublicKey: string;
  token: string;
  auditLogPath: string;
  nonceStorePath: string;
  chainId?: number;
  chainIds?: number[];
  host?: string;
  port?: number;
  socketPath?: string;
  dryRun?: boolean;
  allowNonLoopback?: boolean;
  rpcUrl?: string;
  simulate?: (tx: PendingTransaction) => Promise<SimulationResult>;
  policy?: SpendingPolicy;
  maxPerTxUsd?: number;
  prices?: Record<string, number>;
  tokenCaps?: Record<string, string>;
  priceSourceUrl?: string;
  deny?: DenyListConfig;
}

interface NonceState {
  wallets: Record<string, { lastNonce: string; used: string[] }>;
}

interface AuditEntry {
  timestamp: string;
  requestId: string;
  decision: 'allow' | 'deny' | 'dry_run';
  reason: string;
  wallet: string;
  chainId?: number;
  kind?: string;
  intentHash?: string;
  nonce?: string;
  venue?: string;
  action?: string;
}

class SignerRejection extends Error {
  constructor(message: string, readonly code: EvalancheErrorCode) {
    super(message);
    this.name = 'SignerRejection';
  }
}

function deny(message: string, code: EvalancheErrorCode = EvalancheErrorCode.SIGNER_REJECTED): never {
  throw new SignerRejection(message, code);
}

function normalizeSelector(selector: string): string {
  const value = selector.toLowerCase();
  return value.startsWith('0x') ? value.slice(0, 10) : `0x${value}`.slice(0, 10);
}

function mergeDeny(config: DenyListConfig | undefined): { selectors: string[]; contracts: string[]; venueActions: string[] } {
  const useDefaults = config?.useDefaults !== false;
  return {
    selectors: (config?.selectors ?? []).map(normalizeSelector),
    contracts: (config?.contracts ?? []).map((address) => getAddress(address)),
    venueActions: [
      ...(useDefaults ? DEFAULT_VENUE_ACTIONS : []),
      ...(config?.venueActions ?? []).map((entry) => entry.toLowerCase()),
    ],
  };
}

function parseApproveAmount(data: string | undefined): bigint | null {
  if (!data) return null;
  const normalized = data.toLowerCase();
  if (!normalized.startsWith(APPROVE_SELECTOR)) return null;
  if (normalized.length < 2 + 8 + 64 + 64) {
    deny('ERC-20 approve calldata is truncated', EvalancheErrorCode.SIGNER_REJECTED);
  }
  try {
    return BigInt(`0x${normalized.slice(2 + 8 + 64, 2 + 8 + 64 + 64)}`);
  } catch {
    deny('ERC-20 approve amount could not be decoded', EvalancheErrorCode.SIGNER_REJECTED);
  }
}

function isHyperliquidExchange(request: CanonicalSigningRequest): boolean {
  if (request.kind !== 'typed-data') return false;
  const domain = request.typedData?.domain ?? {};
  return String(domain.name ?? '') === 'Exchange' && Number(domain.chainId ?? 0) === 1337;
}

function venueAction(request: CanonicalSigningRequest): string | null {
  const intent = request.structuredIntent;
  if (intent?.venue && intent.action) {
    return `${intent.venue}:${intent.action}`.toLowerCase();
  }
  if (isHyperliquidExchange(request)) return 'hyperliquid:order';
  return null;
}

function usdMicros(amountIn: string, decimals: number, price: number): bigint {
  if (!Number.isFinite(price) || price < 0) {
    deny('Price source returned a non-finite price', EvalancheErrorCode.SIGNER_REJECTED);
  }
  const priceMicros = BigInt(Math.round(price * 1_000_000));
  const scale = 10n ** BigInt(decimals);
  return (BigInt(amountIn) * priceMicros) / scale;
}

export class EvalancheSignerServer {
  readonly address: string;
  private readonly wallet: Wallet | HDNodeWallet;
  private readonly options: SignerServerOptions;
  private readonly deny: ReturnType<typeof mergeDeny>;
  private readonly policy: PolicyEngine | null;
  private readonly allowedChains: number[];
  private nonces: NonceState = { wallets: {} };
  private queue: Promise<void> = Promise.resolve();
  private http: ReturnType<typeof createServer> | null = null;
  private simulateFn: ((tx: PendingTransaction) => Promise<SimulationResult>) | null;
  private loadedPrices: Record<string, number> | null = null;

  private constructor(wallet: Wallet | HDNodeWallet, options: SignerServerOptions) {
    this.wallet = wallet;
    this.address = wallet.address;
    this.options = options;
    this.deny = mergeDeny(options.deny);
    this.policy = options.policy ? new PolicyEngine(options.policy) : null;
    this.allowedChains = options.chainIds ?? (options.chainId !== undefined ? [options.chainId] : []);
    this.simulateFn = options.simulate ?? null;
    if (!options.token) {
      throw new EvalancheError('Signer auth token is required', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (!options.verifierPublicKey) {
      throw new EvalancheError('Pinned verifier public key is required', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (!options.auditLogPath || !options.nonceStorePath) {
      throw new EvalancheError('auditLogPath and nonceStorePath are required', EvalancheErrorCode.INVALID_CONFIG);
    }
  }

  static async create(options: SignerServerOptions): Promise<EvalancheSignerServer> {
    const wallet = await loadSignerWallet(options);
    const server = new EvalancheSignerServer(wallet, options);
    await server.loadNonces();
    return server;
  }

  async listen(): Promise<{ endpoint: string; port?: number }> {
    const host = this.options.host ?? '127.0.0.1';
    const socketPath = this.options.socketPath;
    if (!socketPath && !this.options.allowNonLoopback && !LOOPBACK_HOSTS.has(host)) {
      throw new EvalancheError(
        `Signer refuses to bind ${host}. The default is 127.0.0.1 or a unix socket.`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    const http = createServer((req, res) => {
      this.handleHttp(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: 'signer failed', code: 'UNKNOWN_ERROR' });
        res.end();
        void error;
      });
    });
    this.http = http;
    if (socketPath) {
      await unlink(socketPath).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(socketPath, () => resolve());
      });
      return { endpoint: `unix://${socketPath}` };
    }
    const port = this.options.port ?? 7410;
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, host, () => resolve());
    });
    const assigned = http.address();
    const actualPort = assigned && typeof assigned === 'object' ? assigned.port : port;
    return { endpoint: `http://${host}:${actualPort}`, port: actualPort };
  }

  async close(): Promise<void> {
    const http = this.http;
    if (!http) return;
    await new Promise<void>((resolve, reject) => {
      http.close((error) => error ? reject(error) : resolve());
    });
    if (this.options.socketPath) await unlink(this.options.socketPath).catch(() => undefined);
    this.http = null;
  }

  /** Decide and maybe sign. Exposed for tests that bypass HTTP. */
  async handle(request: CanonicalSigningRequest): Promise<SigningResult> {
    return this.exclusive(() => this.handleLocked(request));
  }

  private async handleLocked(request: CanonicalSigningRequest): Promise<SigningResult> {
    const base = {
      requestId: request?.requestId ?? 'missing',
      wallet: request?.from ?? '',
      chainId: request?.chainId,
      kind: request?.kind,
      intentHash: request?.approval?.intentHash,
      nonce: request?.approval?.nonce,
      venue: request?.structuredIntent?.venue,
      action: request?.structuredIntent?.action,
    };
    try {
      this.evaluate(request);
      await this.enforceEconomics(request);
      if (request.kind === 'transaction') await this.simulate(request);
      const walletKey = getAddress(request.from).toLowerCase();
      if (this.options.dryRun) {
        await this.audit({ ...base, decision: 'dry_run', reason: 'verified; signature withheld' });
        return { requestId: request.requestId, dryRun: true, decision: 'allow' };
      }
      const signed = await this.produce(request);
      await this.commitNonce(walletKey, request.approval!.nonce);
      await this.audit({ ...base, decision: 'allow', reason: 'signed' });
      return signed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = error instanceof SignerRejection ? error.code : EvalancheErrorCode.SIGNER_REJECTED;
      await this.audit({ ...base, decision: 'deny', reason });
      if (error instanceof SignerRejection) throw error;
      throw new SignerRejection(reason, code);
    }
  }

  private evaluate(request: CanonicalSigningRequest): void {
    if (!request || typeof request !== 'object') deny('Signing request is missing', EvalancheErrorCode.INVALID_PARAMS);
    if (!request.requestId || typeof request.requestId !== 'string') {
      deny('requestId is required', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (!request.intent || typeof request.intent !== 'string' || request.intent.trim().length === 0) {
      deny('A human-readable intent is required', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (request.kind !== 'transaction' && request.kind !== 'message' && request.kind !== 'typed-data') {
      deny('Unknown signing kind', EvalancheErrorCode.INVALID_PARAMS);
    }
    let from: string;
    try {
      from = getAddress(request.from);
    } catch {
      deny('from is not an address', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (from !== this.address) {
      deny(`Signer is ${this.address} and will not sign for ${from}`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (this.allowedChains.length === 0) {
      deny('Signer chain is not configured', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (!this.allowedChains.includes(Number(request.chainId))) {
      deny(`chainId ${request.chainId} is not allowed`, EvalancheErrorCode.SIGNER_REJECTED);
    }

    const approval = request.approval;
    const intent = request.structuredIntent;
    if (!approval) deny('Verifier approval is required', EvalancheErrorCode.APPROVAL_INVALID);
    if (!intent) deny('Structured intent is required', EvalancheErrorCode.APPROVAL_INVALID);
    this.assertApproval(request, approval, intent);
    this.assertDenyList(request, intent);
    this.assertApprovalAmount(request, intent);
  }

  private assertApproval(request: CanonicalSigningRequest, approval: VerifierApproval, intent: SigningIntent): void {
    if (!keysEqual(approval.verifier, this.options.verifierPublicKey)) {
      deny('Approval was signed by the wrong verifier key', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const now = Date.now();
    if (!Number.isFinite(approval.expiresAt) || now >= approval.expiresAt) {
      deny('Approval is expired', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (Number(intent.expiresAt) !== Number(approval.expiresAt)) {
      deny('Intent expiry does not match the approval', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (String(intent.nonce) !== String(approval.nonce)) {
      deny('Intent nonce does not match the approval', EvalancheErrorCode.APPROVAL_INVALID);
    }
    try {
      if (getAddress(intent.wallet) !== getAddress(request.from)) {
        deny('Intent wallet does not match the transaction sender', EvalancheErrorCode.APPROVAL_INVALID);
      }
    } catch {
      deny('Intent wallet is not an address', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (Number(intent.chainId) !== Number(request.chainId)) {
      deny('Intent chainId does not match the transaction', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const routeHash = computeRequestRouteHash(request);
    if (String(intent.routeHash).toLowerCase() !== routeHash.toLowerCase()) {
      deny('routeHash does not match keccak256 of the transaction data', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (actionRequiresMinAmountOut(intent.action) && (intent.minAmountOut === undefined || intent.minAmountOut === '')) {
      deny('minAmountOut bound is required for this action', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const recomputed = computeIntentHash(intent);
    if (recomputed.toLowerCase() !== String(approval.intentHash).toLowerCase()) {
      deny('intentHash does not match the canonical intent (wrong hash)', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (!verifyIntentHash(recomputed, approval.signature, this.options.verifierPublicKey)) {
      deny('Approval signature is invalid', EvalancheErrorCode.APPROVAL_INVALID);
    }
    this.assertNonce(getAddress(request.from).toLowerCase(), approval.nonce, approval.expiresAt);
  }

  private assertNonce(wallet: string, nonce: string, expiresAt: number): void {
    if (!/^\d+$/.test(nonce)) deny('Approval nonce must be a decimal integer', EvalancheErrorCode.APPROVAL_INVALID);
    const entry = this.nonces.wallets[wallet] ?? { lastNonce: '-1', used: [] };
    if (entry.used.includes(nonce)) {
      deny('Replayed nonce: this approval was already used', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (BigInt(nonce) <= BigInt(entry.lastNonce)) {
      deny('Replayed nonce: approval nonce is not greater than the last signed nonce', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (Date.now() >= expiresAt) deny('Approval is expired', EvalancheErrorCode.APPROVAL_INVALID);
  }

  private assertDenyList(request: CanonicalSigningRequest, intent: SigningIntent): void {
    const selector = (request.data ?? '').toLowerCase().slice(0, 10);
    if (selector.length === 10 && this.deny.selectors.includes(selector)) {
      deny(`Function selector ${selector} is denied`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (request.to) {
      const to = getAddress(request.to);
      if (this.deny.contracts.includes(to)) {
        deny(`Contract ${to} is denied`, EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
    const action = venueAction(request);
    if (action && this.deny.venueActions.includes(action)) {
      deny(`Venue action ${action} is denied`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (isHyperliquidExchange(request) && this.deny.venueActions.includes('hyperliquid:order') && (!intent.action || /order|cancel|modify/i.test(intent.action))) {
      deny('Hyperliquid order tools are denied', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private assertApprovalAmount(request: CanonicalSigningRequest, intent: SigningIntent): void {
    const amount = parseApproveAmount(request.data);
    if (amount === null) return;
    if (amount === MAX_UINT256) {
      deny('Unlimited ERC-20 approval is denied', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (intent.amountIn === undefined || intent.amountIn === '') {
      deny('ERC-20 approve requires amountIn and the approved amount must equal amountIn', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (amount !== BigInt(intent.amountIn)) {
      deny('ERC-20 approve amount must equal amountIn', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private async enforceEconomics(request: CanonicalSigningRequest): Promise<void> {
    const intent = request.structuredIntent!;
    if (this.policy && request.kind === 'transaction' && request.to) {
      const pending: PendingTransaction = {
        to: request.to,
        value: request.value ?? '0',
        data: request.data,
        chainId: Number(request.chainId),
        gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
      };
      const result = this.policy.evaluate(pending);
      if (!result.allowed && !this.policy.policy.dryRun) {
        deny(`Spending policy rejected the transaction: ${result.reason}`, EvalancheErrorCode.POLICY_VIOLATION);
      }
    }
    const caps = this.options.tokenCaps ?? {};
    const nativeCap = caps.native;
    if (nativeCap !== undefined && BigInt(request.value ?? '0') > BigInt(nativeCap)) {
      deny('Transaction value exceeds the native token cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (intent.amountIn && intent.tokenIn) {
      const cap = caps[intent.tokenIn.address.toLowerCase()] ?? caps[getAddress(intent.tokenIn.address)];
      if (cap !== undefined && BigInt(intent.amountIn) > BigInt(cap)) {
        deny('Token amount exceeds the configured per-transaction cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
      }
      if (this.options.maxPerTxUsd !== undefined) {
        const price = await this.priceOf(intent.tokenIn);
        if (price === null) {
          deny(`No price for ${intent.tokenIn.symbol || intent.tokenIn.address}; refusing to sign without a cap`, EvalancheErrorCode.SIGNER_REJECTED);
        }
        const micros = usdMicros(intent.amountIn, intent.tokenIn.decimals, price);
        const capMicros = BigInt(Math.round(this.options.maxPerTxUsd * 1_000_000));
        if (micros > capMicros) {
          deny('Token amount exceeds the per-transaction USD cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
        }
      }
    }
  }

  private async priceOf(token: { address: string; symbol: string }): Promise<number | null> {
    const prices = await this.prices();
    const byAddress = prices[token.address.toLowerCase()];
    if (typeof byAddress === 'number') return byAddress;
    if (token.symbol && typeof prices[token.symbol] === 'number') return prices[token.symbol];
    if (token.symbol && typeof prices[token.symbol.toUpperCase()] === 'number') return prices[token.symbol.toUpperCase()];
    return null;
  }

  private async prices(): Promise<Record<string, number>> {
    if (this.loadedPrices) return { ...this.options.prices, ...this.loadedPrices };
    const merged: Record<string, number> = { ...(this.options.prices ?? {}) };
    if (this.options.priceSourceUrl) {
      const response = await fetch(this.options.priceSourceUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) deny('Price source request failed', EvalancheErrorCode.NETWORK_ERROR);
      const body = await response.json() as Record<string, unknown>;
      const table = (body.prices && typeof body.prices === 'object' ? body.prices : body) as Record<string, unknown>;
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'number') merged[key] = value;
      }
      this.loadedPrices = merged;
    }
    return merged;
  }

  private async simulate(request: CanonicalSigningRequest): Promise<void> {
    if (!request.to) deny('Transaction is missing to; refusing to sign', EvalancheErrorCode.SIMULATION_FAILED);
    const simulate = await this.simulator();
    const result = await simulate({
      to: request.to,
      value: request.value ?? '0',
      data: request.data,
      chainId: Number(request.chainId),
      gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
    });
    if (!result.success) {
      deny(`Simulation failed: ${result.revertReason ?? 'unknown revert'}`, EvalancheErrorCode.SIMULATION_FAILED);
    }
  }

  private async simulator(): Promise<(tx: PendingTransaction) => Promise<SimulationResult>> {
    if (this.simulateFn) return this.simulateFn;
    if (!this.options.rpcUrl) {
      deny('Simulation requires rpcUrl or an injected simulator', EvalancheErrorCode.SIMULATION_FAILED);
    }
    const provider = new JsonRpcProvider(this.options.rpcUrl);
    this.simulateFn = (tx) => simulateTransaction(provider, tx);
    return this.simulateFn;
  }

  private async produce(request: CanonicalSigningRequest): Promise<SigningResult> {
    if (request.kind === 'transaction') {
      const tx: TransactionRequest = {
        to: request.to ?? undefined,
        value: BigInt(request.value ?? '0'),
        data: request.data ?? '0x',
        chainId: request.chainId,
        nonce: request.nonce,
        gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
        gasPrice: request.gasPrice ? BigInt(request.gasPrice) : undefined,
        maxFeePerGas: request.maxFeePerGas ? BigInt(request.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: request.maxPriorityFeePerGas ? BigInt(request.maxPriorityFeePerGas) : undefined,
        type: request.type,
      };
      const signedTransaction = await this.wallet.signTransaction(tx);
      return { requestId: request.requestId, signedTransaction };
    }
    if (request.kind === 'message') {
      const signature = await this.wallet.signMessage(request.message ?? '');
      return { requestId: request.requestId, signature };
    }
    const typed = request.typedData;
    if (!typed) deny('typedData is required', EvalancheErrorCode.INVALID_PARAMS);
    const signature = await this.wallet.signTypedData(
      typed.domain as never,
      typed.types as never,
      typed.value,
    );
    return { requestId: request.requestId, signature };
  }

  private async commitNonce(wallet: string, nonce: string): Promise<void> {
    const entry = this.nonces.wallets[wallet] ?? { lastNonce: '-1', used: [] };
    entry.used.push(nonce);
    entry.lastNonce = nonce;
    this.nonces.wallets[wallet] = entry;
    await this.saveNonces();
  }

  private async loadNonces(): Promise<void> {
    try {
      const raw = await readFile(this.options.nonceStorePath, 'utf8');
      const parsed = JSON.parse(raw) as NonceState;
      if (parsed && typeof parsed === 'object' && parsed.wallets) this.nonces = parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  private async saveNonces(): Promise<void> {
    await mkdir(dirname(this.options.nonceStorePath), { recursive: true });
    const tmp = `${this.options.nonceStorePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.nonces), { mode: 0o600 });
    await rename(tmp, this.options.nonceStorePath);
  }

  private async audit(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    const line: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
    await mkdir(dirname(this.options.auditLogPath), { recursive: true });
    await appendFile(this.options.auditLogPath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, address: this.address, dryRun: Boolean(this.options.dryRun) });
      return;
    }
    if (req.url !== '/v1/sign' || req.method !== 'POST') {
      sendJson(res, 404, { error: 'Not found', code: 'INVALID_PARAMS' });
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !bearerEquals(this.options.token, presented)) {
      sendJson(res, 401, { error: 'Unauthorized', code: 'INVALID_CONFIG' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 400, { error: message, code: 'INVALID_PARAMS' });
      return;
    }
    let request: CanonicalSigningRequest;
    try {
      request = JSON.parse(raw) as CanonicalSigningRequest;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON', code: 'INVALID_PARAMS' });
      return;
    }
    try {
      const result = await this.handle(request);
      sendJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof SignerRejection ? error.code : EvalancheErrorCode.SIGNER_REJECTED;
      const status = code === EvalancheErrorCode.INVALID_PARAMS ? 400 : 403;
      sendJson(res, status, { error: message, code });
    }
  }
}

async function loadSignerWallet(options: SignerServerOptions): Promise<Wallet | HDNodeWallet> {
  const envKey = process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
  if (options.privateKey && options.keystorePath) {
    throw new EvalancheError(
      'privateKey and keystorePath are mutually exclusive',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  if (options.privateKey) return new Wallet(options.privateKey);
  if (envKey && options.keystorePath) {
    throw new EvalancheError(
      'EVALANCHE_SIGNER_PRIVATE_KEY and keystorePath are mutually exclusive',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  if (envKey) return new Wallet(envKey);
  if (options.keystorePath) {
    const envName = options.keystorePasswordEnv ?? 'EVALANCHE_SIGNER_KEYSTORE_PASSWORD';
    const password = process.env[envName];
    if (!password) {
      throw new EvalancheError(`Keystore password env ${envName} is empty`, EvalancheErrorCode.INVALID_CONFIG);
    }
    const json = await readFile(options.keystorePath, 'utf8');
    return Wallet.fromEncryptedJson(json, password);
  }
  throw new EvalancheError(
    'No signer key configured. Set EVALANCHE_SIGNER_PRIVATE_KEY or keystorePath.',
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SignerRejection('Signing request body is too large', EvalancheErrorCode.INVALID_PARAMS));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startSignerServer(options: SignerServerOptions): Promise<EvalancheSignerServer & { endpoint: string; port?: number }> {
  const server = await EvalancheSignerServer.create(options);
  const listening = await server.listen();
  return Object.assign(server, listening);
}
