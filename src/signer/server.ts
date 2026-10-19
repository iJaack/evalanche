/**
 * Reference signer. The private key lives only in this process.
 *
 * A signature is produced only after the signer has checked a domain-separated
 * Ed25519 approval, matched every transaction field to the approved object,
 * decoded known calldata, and applied the allowlist, built-in denials, gas
 * cap, spending policy, and simulation. Dry-run does the same and consumes
 * the nonce, then returns without a signature.
 *
 * The audit log is append-only JSONL. Its chain root is the hex SHA-256 of
 * the UTF-8 string `evalanche-audit-root/v1`. That root is fixed in code, not
 * taken from config. The first record stores it as `prevHash`. Each later
 * record stores the SHA-256 of the previous line. The process refuses to
 * start when the chain does not link back to the root.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { open as openFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertSecureParents, assertSignerStateDirectory, assertSocketDirectory, assertStateFileIfExists, readSecureFile } from './secure-path';
import { JsonRpcProvider, Wallet, getAddress, keccak256, toUtf8Bytes, type TransactionRequest } from 'ethers';
import type { HDNodeWallet } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { PolicyEngine } from '../economy/policies';
import { simulateTransaction, type SimulationResult } from '../economy/simulation';
import type { PendingTransaction, SpendingPolicy } from '../economy/types';
import {
  actionRequiresMinAmountOut,
  approvalSigningBytes,
  assertIntentShape,
  computeApprovedTxHash,
  computeIntentHash,
  computeMessageRouteHash,
  assertEd25519PublicKey,
  computeTypedDataRouteHash,
  keysEqual,
  verifyBytes,
  type ApprovalMode,
  type ApprovedTransaction,
  type CanonicalSigningRequest,
  type SigningIntent,
  type SigningResult,
  type TypedDataPayload,
  type VerifierApproval,
} from './intent';
import {
  NATIVE_ADDRESS,
  canonicalAsset,
  decodeCalldata,
  isHardDeniedContract,
  isLifiV3Selector,
  isSavaxInstantUnstake,
  selectorOf,
  type AllowRole,
  type DecodedCall,
} from './decode';
import { NonceStore, writeDurable } from './nonce-store';
import { resolveSignerPolicy, rpcUrlsFor, tokenCap, type ResolvedChain, type SignerChainConfig, type SignerPolicy } from './chain-policy';
import { assertCoinGeckoPricePlausible, coinGeckoBindings, fetchCoinGeckoSimplePrice, nativeCoinGeckoId } from './price-feed';
import { CLMM_CHAIN_ID, assertClmmConfig, clmmFundingTokens, isClmmNpmApprove, isClmmPositionManager } from './clmm';
import { assertDexConfig, dexVenue, isDexRouter } from './dex-venue';
import {
  assertClobAuth,
  assertPolymarketConfig,
  assertPolymarketOrder,
  isPolymarketCollateralApprove,
} from './polymarket-module';
import { PM_CHAIN_ID, PM_CLOB_AUTH_DOMAIN } from './polymarket-addresses';
import { assertCctpConfig, cctpModuleHandles } from './cctp';
import { assertRevokeOnlyConfig, isKnownRevokeToken, isRevokeOnlySelector, revokeOnlyEnabled } from './revoke-only';
import type { SpendRecord } from '../economy/types';
import { bearerEquals } from './remote-client';

/** One native token. Config may lower this. It cannot raise it. */
export const HARD_MAX_GAS_COST_WEI = 10n ** 18n;
/** Default gas budget, about 0.02 native tokens (0.02 AVAX on Avalanche). */
export const DEFAULT_MAX_GAS_COST_WEI = 20_000_000_000_000_000n;
export const MAX_APPROVAL_SKEW_MS = 30_000;
export const MAX_APPROVAL_TTL_MS = 600_000;
export const AUDIT_ROOT = createHash('sha256').update('evalanche-audit-root/v1').digest('hex');

const MAX_BODY_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 200;
const SHUTDOWN_FORCE_MS = 3_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_PRICE_TTL_MS = 60_000;
const TX_FIELDS = [
  'to', 'value', 'data', 'chainId', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice', 'type',
] as const;

export interface AllowEntry {
  address: string;
  selectors: string[];
  /** Decimals used when a USD cap prices this token. Intent decimals are not trusted. */
  decimals?: number;
  /** ERC-4626 underlying. Deposit caps price this asset, not the vault. */
  underlying?: string;
  /**
   * What this address may be. `dex` is callTo, `spender` is approveTo / approve,
   * `recipient` receives an ERC-20 transfer, a native send, or a Li.Fi V3 swap,
   * `token` is an asset, and `vault` is a deposit or redeem target. A token is
   * never accepted as callTo.
   */
  roles?: AllowRole[];
}

export interface TypedDataAllow {
  domainName: string;
  primaryType: string;
  chainId?: number;
  verifyingContract?: string;
}

export type ExplicitAllow = 'permit' | 'permit2' | 'increaseAllowance';

/** Default Li.Fi V3 slippage caps, in basis points, by bought-token class. */
export const DEFAULT_STABLE_SLIPPAGE_BPS = 50;
export const DEFAULT_TOP_SLIPPAGE_BPS = 200;
export const DEFAULT_OTHER_SLIPPAGE_BPS = 300;

/** Avalanche stables. USDC is 50 bps. USDT and USDC.e are the same class. */
export const DEFAULT_AVALANCHE_STABLES = [
  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  '0xc7198437980c041c805A1EDcbA50c1Ce5db95118',
];

/** Avalanche top assets: WAVAX, BTC.b, WETH.e, and sAVAX. Each is 200 bps. */
export const DEFAULT_AVALANCHE_TOP = [
  '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
  '0x152b9d0FdC40C096757F570A51E494bd4b943E50',
  '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
  '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE',
];

/**
 * Bought-token classes for a Li.Fi V3 quote floor. The Avalanche stables and
 * top assets above apply even when config lists are empty. Config lists add
 * addresses. An unlisted token uses `otherBps`.
 */
export interface SlippageCaps {
  /** Bought tokens capped at `stableBps` (default 50). */
  stables?: string[];
  /** Bought tokens capped at `topBps` (default 200). An address in both lists is a stable. */
  top?: string[];
  stableBps?: number;
  topBps?: number;
  otherBps?: number;
}

export interface SignerServerOptions {
  privateKey?: string;
  keystorePath?: string;
  keystorePasswordEnv?: string;
  verifierPublicKey: string;
  /** Path to the pinned verifier key file, checked for root ownership when set. */
  verifierPublicKeyPath?: string;
  /** Path to the signer config file, checked for root ownership when set. */
  configPath?: string;
  /**
   * Root-owned directory where state-path parent checks stop. Components
   * above it may be owned by another user. The anchor itself must be
   * root-owned, and a symlink anywhere in the path is refused. Config and
   * verifier-key files still walk all the way to `/`.
   */
  trustAnchor?: string;
  /**
   * Test-only escape hatch. Production startup refuses a config, keystore, or
   * verifier pubkey file that is not root-owned or is writable by group/other.
   */
  allowInsecureFilePermissions?: boolean;
  token: string;
  auditLogPath: string;
  nonceStorePath: string;
  /** Required when the nonce file is missing or empty. Otherwise startup fails. */
  initNonces?: boolean;
  chainId?: number;
  chainIds?: number[];
  /** Required non-empty map of chain id to allowed contract selectors. */
  allow: Record<string, AllowEntry[]>;
  host?: string;
  port?: number;
  socketPath?: string;
  dryRun?: boolean;
  allowNonLoopback?: boolean;
  rpcUrl?: string;
  simulate?: (tx: PendingTransaction) => Promise<SimulationResult>;
  policy?: SpendingPolicy;
  maxPerTxUsd?: number;
  /** USD prices keyed only by token address. The native token is the zero address. */
  prices?: Record<string, number>;
  tokenCaps?: Record<string, string>;
  priceSourceUrl?: string;
  /** Legacy file only. CoinGecko simple/price. Not copied onto `chains`. */
  priceFeed?: 'coingecko' | { provider?: string; url?: string; maxAgeMs?: number };
  priceTtlMs?: number;
  /** Tightens the hard gas-cost cap. Values above the hard cap are refused. */
  maxGasCostWei?: string;
  /**
   * Li.Fi V3 slippage caps for the bought token. Defaults are 50 bps for
   * `stables`, 200 for `top`, and 300 for every other token.
   */
  slippageCaps?: SlippageCaps;
  /**
   * Kyber AggregationExecutor addresses a V3 leg may name as `callTarget`.
   * Defaults to the Avalanche executor proxy. An empty list allows none.
   */
  kyberExecutors?: string[];
  /**
   * Per-chain RPC lists. Simulation uses the list for the request's chain.
   * Two or more URLs are supported; the first success wins and a revert does
   * not fall through.
   */
  rpcUrls?: Record<string, string[]>;
  /**
   * Per-chain policy. When this object is present it replaces chainId /
   * chainIds for enablement. 43114 stays on unless that entry sets
   * `enabled: false` or `killSwitch: true`. Every other chain stays off
   * unless `enabled: true`. Old files omit this and keep their chain list.
   */
  chains?: Record<string, SignerChainConfig>;
  messageAllowlist?: string[];
  typedDataAllow?: TypedDataAllow[];
  explicitAllows?: ExplicitAllow[];
  keyId?: string;
}

interface AuditEntry {
  prevHash: string;
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
  txHash?: string;
  to?: string;
  value?: string;
  routeHash?: string;
  keyId?: string;
  approvalSignature?: string;
  /** Present for a polymarket-order or clob-auth signature. */
  orderHash?: string;
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

function stripUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted-url]');
}

function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}

export class EvalancheSignerServer {
  readonly address: string;
  readonly stateStartedAt: number;
  private readonly wallet: Wallet | HDNodeWallet;
  private readonly options: SignerServerOptions;
  private readonly policy: PolicyEngine | null;
  private readonly allowedChains: number[];
  private readonly allow: Map<number, AllowEntry[]>;
  private readonly explicitAllows: Set<string>;
  private readonly gasCap: bigint;
  private readonly chainPolicy: SignerPolicy;
  private readonly nonces: NonceStore;
  private prevHash = AUDIT_ROOT;
  private queue: Promise<void> = Promise.resolve();
  private http: ReturnType<typeof createServer> | null = null;
  private halted = false;
  private haltReason = 'signer stopped';
  private shutdownStarted = false;
  private resourcesClosed = false;
  private injectedSimulate: ((tx: PendingTransaction) => Promise<SimulationResult>) | null;
  private readonly rpcSimulators = new Map<number, (tx: PendingTransaction) => Promise<SimulationResult>>();
  private priceCache = new Map<string, { fetchedAt: number; prices: Record<string, number> }>();

  private constructor(wallet: Wallet | HDNodeWallet, options: SignerServerOptions, nonces: NonceStore) {
    this.wallet = wallet;
    this.address = wallet.address;
    this.options = options;
    this.nonces = nonces;
    this.stateStartedAt = nonces.startedAt;
    this.policy = options.policy ? new PolicyEngine(options.policy) : null;
    this.chainPolicy = resolveSignerPolicy(options, {
      defaultMaxFeeWei: DEFAULT_MAX_GAS_COST_WEI,
      hardMaxFeeWei: HARD_MAX_GAS_COST_WEI,
    });
    this.allowedChains = this.chainPolicy.enabled;
    this.allow = indexAllow(options.allow);
    this.augmentClmmAllow();
    this.explicitAllows = new Set(options.explicitAllows ?? []);
    this.gasCap = resolveGasCap(options.maxGasCostWei);
    this.injectedSimulate = options.simulate ?? null;
  }

  static async create(options: SignerServerOptions): Promise<EvalancheSignerServer> {
    takeSignerEnvToken();
    const resolved = await resolveVerifierKey(options);
    assertStartup(resolved);
    const keystoreJson = await assertFilePermissions(resolved);
    options = resolved;
    if (options.policy?.dryRun) {
      throw new EvalancheError(
        'Signer refuses a spending policy with dryRun enabled',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    if (options.priceSourceUrl && !options.priceSourceUrl.startsWith('https://')) {
      throw new EvalancheError('Price source URL must be https', EvalancheErrorCode.INVALID_CONFIG);
    }
    const wallet = await loadSignerWallet(options, keystoreJson);
    const bridge: { server?: EvalancheSignerServer } = {};
    const nonces = await NonceStore.open(options.nonceStorePath, options.initNonces === true, {
      allowInsecureFilePermissions: options.allowInsecureFilePermissions === true,
      onLockLost: () => {
        if (bridge.server) bridge.server.stopBecauseLockLost();
        else process.exit(1);
      },
    });
    const server = new EvalancheSignerServer(wallet, options, nonces);
    bridge.server = server;
    try {
      if (server.policy) server.policy.restore(await readBudget(options.nonceStorePath));
      await server.loadAudit();
    } catch (error) {
      await nonces.close();
      throw error;
    }
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
      const dirMode = (await stat(dirname(socketPath))).mode & 0o777;
      if (dirMode !== 0o750) {
        throw new EvalancheError(
          `Unix socket directory must be mode 0750, found 0${dirMode.toString(8)}`,
          EvalancheErrorCode.INVALID_CONFIG,
        );
      }
      const { unlink } = await import('node:fs/promises');
      await unlink(socketPath).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(socketPath, () => resolve());
      });
      await chmod(socketPath, 0o660);
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
    if (http) {
      if (this.shutdownStarted) http.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
    }
    await this.finishClose();
  }

  /**
   * Refuse every route and every signature. Call this before closing sockets
   * so an in-flight keep-alive request cannot still be signed.
   */
  halt(reason = 'signer stopped'): void {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
  }

  /**
   * The nonce lock helper exited after startup. Halt first, then leave the
   * process with a non-zero status. release() does not call this.
   */
  stopBecauseLockLost(): void {
    this.beginShutdown((code) => process.exit(code), 1, 'signer stopped: nonce lock lost');
  }

  /**
   * Halt first so every route, including an in-flight keep-alive request,
   * returns 503 and does not sign. Then stop accepting, destroy sockets after
   * a short grace, and force the process out if that path stalls.
   */
  beginShutdown(exit: (code: number) => void, code = 0, reason?: string): void {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.halt(reason ?? (code === 0 ? 'signer stopped' : 'signer stopped: nonce lock lost'));
    const http = this.http;
    // Do not wait for the close callback. It runs only after connections drain.
    http?.close();
    const force = setTimeout(() => {
      try { http?.closeAllConnections(); } catch { /* already closed */ }
      exit(code);
    }, SHUTDOWN_FORCE_MS);
    force.unref();
    setTimeout(() => {
      try { http?.closeAllConnections(); } catch { /* already closed */ }
      void this.finishClose().then(
        () => {
          clearTimeout(force);
          exit(code);
        },
        () => {
          clearTimeout(force);
          exit(code === 0 ? 1 : code);
        },
      );
    }, SHUTDOWN_GRACE_MS);
  }

  private async finishClose(): Promise<void> {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    if (this.options.socketPath) {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.options.socketPath).catch(() => undefined);
    }
    this.http = null;
    await this.nonces.close();
  }

  async handle(request: CanonicalSigningRequest): Promise<SigningResult> {
    this.assertRunning();
    return this.exclusive(() => this.handleLocked(request));
  }

  private assertRunning(): void {
    if (this.halted) {
      throw new EvalancheError(this.haltReason, EvalancheErrorCode.INVALID_CONFIG);
    }
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
      to: request?.to ?? undefined,
      value: request?.value,
      routeHash: request?.structuredIntent?.routeHash,
      keyId: this.options.keyId ?? this.address,
      approvalSignature: request?.approval?.signature,
    };
    try {
      const checked = this.evaluate(request);
      const decoded = request.kind === 'transaction' ? this.decode(request, checked) : [];
      await this.enforceEconomics(request, decoded);
      if (request.kind === 'transaction') await this.simulate(request);
      const walletKey = getAddress(request.from).toLowerCase();
      this.nonces.note(walletKey, request.approval!.nonce);
      const order = this.noteModuleReplay(request);
      if (request.kind === 'transaction' && request.nonce !== undefined && request.nonce !== null) {
        this.nonces.noteTxNonce(walletKey, Number(request.chainId), String(request.nonce));
      }
      await this.nonces.persist();
      if (this.options.dryRun) {
        this.assertRunning();
        await this.audit({ ...base, decision: 'dry_run', reason: 'verified; signature withheld', ...order });
        return { requestId: request.requestId, dryRun: true, decision: 'allow' };
      }
      this.assertRunning();
      const signed = await this.produce(request);
      if (this.policy && request.kind === 'transaction') {
        const txHash = signed.signedTransaction ? keccak256(signed.signedTransaction) : signed.requestId;
        this.policy.recordSpend({
          txHash,
          amount: request.value ?? '0',
          to: request.to ?? this.address,
          chainId: Number(request.chainId),
          timestamp: Date.now(),
        });
        await this.persistBudget();
      }
      await this.audit({
        ...base,
        decision: 'allow',
        reason: this.allowReason(request),
        txHash: signed.signedTransaction ? keccak256(signed.signedTransaction) : undefined,
        ...order,
      });
      return signed;
    } catch (error) {
      const reason = stripUrls(error instanceof Error ? error.message : String(error));
      const code = error instanceof SignerRejection
        ? error.code
        : error instanceof EvalancheError
          ? error.code
          : EvalancheErrorCode.SIGNER_REJECTED;
      await this.audit({ ...base, decision: 'deny', reason });
      throw new SignerRejection(reason, code);
    }
  }

  private evaluate(request: CanonicalSigningRequest): SigningIntent {
    if (!request || typeof request !== 'object') deny('Signing request is missing', EvalancheErrorCode.INVALID_PARAMS);
    if (!request.requestId || typeof request.requestId !== 'string') {
      deny('requestId is required', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (!request.intent || typeof request.intent !== 'string' || request.intent.trim().length === 0) {
      deny('A human-readable intent is required', EvalancheErrorCode.INVALID_PARAMS);
    }
    if (
      request.kind !== 'transaction'
      && request.kind !== 'message'
      && request.kind !== 'typed-data'
      && request.kind !== 'polymarket-order'
      && request.kind !== 'clob-auth'
    ) {
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
    if (!this.allowedChains.includes(Number(request.chainId))) {
      const known = this.chainPolicy.chains.has(Number(request.chainId));
      if (known || this.allowedChains.length > 0) {
        deny(`chainId ${request.chainId} is not allowed`, EvalancheErrorCode.SIGNER_REJECTED);
      }
      deny('Signer chain is not configured', EvalancheErrorCode.INVALID_CONFIG);
    }
    const approval = request.approval;
    if (!approval) deny('Verifier approval is required', EvalancheErrorCode.APPROVAL_INVALID);
    let intent: SigningIntent;
    try {
      intent = assertIntentShape(request.structuredIntent);
    } catch (error) {
      deny(error instanceof Error ? error.message : 'Structured intent is invalid', EvalancheErrorCode.APPROVAL_INVALID);
    }
    this.assertApproval(request, approval, intent);
    if (request.kind === 'transaction') this.assertTransaction(request, intent);
    else if (request.kind === 'message') this.assertMessage(request, intent);
    else if (request.kind === 'typed-data') this.assertTypedData(request, intent);
    else if (request.kind === 'polymarket-order') this.assertPolymarketKind(request, intent);
    else this.assertClobAuthKind(request);
    return intent;
  }

  private assertApproval(request: CanonicalSigningRequest, approval: VerifierApproval, intent: SigningIntent): void {
    if (!keysEqual(approval.verifier, this.options.verifierPublicKey)) {
      deny('Approval was signed by the wrong verifier key', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const now = Date.now();
    if (!Number.isSafeInteger(intent.createdAt) || intent.createdAt > now + MAX_APPROVAL_SKEW_MS) {
      deny('createdAt is too far in the future', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now) {
      deny('Approval is expired', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (intent.expiresAt - intent.createdAt > MAX_APPROVAL_TTL_MS) {
      deny('approval lifetime exceeds 600000ms', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (intent.createdAt < this.nonces.startedAt) {
      deny('approval was created before the signer state start', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (Number(intent.expiresAt) !== Number(approval.expiresAt)) {
      deny('Intent expiry does not match the approval', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (String(intent.nonce) !== String(approval.nonce)) {
      deny('Intent nonce does not match the approval', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (getAddress(intent.wallet) !== getAddress(request.from)) {
      deny('Intent wallet does not match the transaction sender', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (Number(intent.chainId) !== Number(request.chainId)) {
      deny('Intent chainId does not match the transaction', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const recomputedEarly = computeIntentHash(intent);
    if (recomputedEarly.toLowerCase() !== String(approval.intentHash).toLowerCase()) {
      deny('intentHash does not match the canonical intent (wrong hash)', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (approval.decision !== 'approve') {
      deny('approval decision is not approve', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const mode: ApprovalMode = this.options.dryRun ? 'dry-run' : 'live';
    if (approval.mode !== mode) {
      deny('approval mode does not match the signer', EvalancheErrorCode.APPROVAL_INVALID);
    }
    let signerAddress: string;
    try {
      signerAddress = getAddress(approval.signerAddress);
    } catch {
      deny('approval signerAddress is not an address', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (signerAddress !== this.address) {
      deny('approval signerAddress does not match the signer', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const message = approvalSigningBytes({
      decision: 'approve',
      mode,
      signerAddress,
      chainId: intent.chainId,
      intentHash: recomputedEarly,
    });
    if (!verifyBytes(message, approval.signature, this.options.verifierPublicKey)) {
      deny('Approval signature is invalid', EvalancheErrorCode.APPROVAL_INVALID);
    }
    this.assertNonce(getAddress(request.from).toLowerCase(), approval.nonce);
  }

  private assertNonce(wallet: string, nonce: string): void {
    if (!/^(0|[1-9][0-9]*)$/.test(nonce)) deny('Approval nonce must be a decimal string', EvalancheErrorCode.APPROVAL_INVALID);
    const entry = this.nonces.get(wallet);
    if (entry.used.includes(nonce)) {
      deny('Replayed nonce: this approval was already used', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (BigInt(nonce) <= BigInt(entry.lastNonce)) {
      deny('Replayed nonce: approval nonce is not greater than the last signed nonce', EvalancheErrorCode.APPROVAL_INVALID);
    }
  }

  private assertTransaction(request: CanonicalSigningRequest, intent: SigningIntent): void {
    if (!intent.tx) deny('transaction is not bound and does not match an approved transaction object', EvalancheErrorCode.APPROVAL_INVALID);
    const actual = requestTx(request);
    for (const field of TX_FIELDS) {
      if (String(actual[field]) !== String(intent.tx[field])) {
        deny(`transaction field ${field} does not match the approved transaction`, EvalancheErrorCode.APPROVAL_INVALID);
      }
    }
    const route = computeApprovedTxHash(intent.tx);
    if (route.toLowerCase() !== intent.routeHash.toLowerCase()) {
      deny('routeHash does not match the approved transaction', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const chain = this.chainFor(Number(request.chainId));
    assertGas(intent.tx, chain?.maxFeeWei ?? this.gasCap);
    if (intent.tx.type === 113) {
      deny('zkSync transaction type 113 is denied', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const gasMode = chain?.gasMode ?? 'both';
    if (gasMode === 'legacy' && intent.tx.type !== 0) {
      deny('transaction type is not allowed', EvalancheErrorCode.SIGNER_REJECTED);
    } else if (gasMode === 'eip1559' && intent.tx.type !== 2) {
      deny('transaction type is not allowed', EvalancheErrorCode.SIGNER_REJECTED);
    } else if (intent.tx.type !== 0 && intent.tx.type !== 2) {
      deny('transaction type is not allowed', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const handled = this.moduleHandles(request);
    if (request.to && isHardDeniedContract(request.to) && !handled) {
      deny(`Contract ${getAddress(request.to)} is a built-in Polymarket denial`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (request.to && isSavaxInstantUnstake(request.to, request.data ?? '0x')) {
      deny('Benqi sAVAX instant unstake (redeemInstant) is denied and cannot be enabled by config', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const polymarketVenue = intent.venue.toLowerCase() === 'polymarket' || intent.action.toLowerCase().startsWith('polymarket');
    if (polymarketVenue && !handled) {
      deny('Polymarket is denied and cannot be enabled by config', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (handled) return;
    const selector = selectorOf(request.data);
    const entry = this.allowEntry(Number(request.chainId), request.to);
    if (!entry || !entry.selectors.map((item) => item.toLowerCase()).includes(selector)) {
      deny(`Function selector ${selector} is not allowlisted`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (request.to && chain?.lifiSelectors && sameAddress(request.to, chain.lifiDiamond)) {
      if (!chain.lifiSelectors.includes(selector)) {
        deny(`Function selector ${selector} is not allowlisted`, EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
  }

  private assertMessage(request: CanonicalSigningRequest, intent: SigningIntent): void {
    const message = (request.message ?? '').normalize('NFC');
    const route = computeMessageRouteHash(message);
    if (route.toLowerCase() !== intent.routeHash.toLowerCase()) {
      deny('routeHash does not match the message', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const allowed = (this.options.messageAllowlist ?? []).map((entry) => entry.normalize('NFC'));
    if (!allowed.includes(message)) {
      deny('message signing is disabled unless the message is on the allowlist', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private assertTypedData(request: CanonicalSigningRequest, intent: SigningIntent): void {
    const typed = request.typedData;
    if (!typed) deny('typedData is required', EvalancheErrorCode.INVALID_PARAMS);
    const route = computeTypedDataRouteHash(typed);
    if (route.toLowerCase() !== intent.routeHash.toLowerCase()) {
      deny('routeHash does not match the typed data', EvalancheErrorCode.APPROVAL_INVALID);
    }
    if (isHyperliquidTypedData(typed)) {
      deny('Hyperliquid typed data is denied by domain and type', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (isPolymarketTypedData(typed) || isClobAuthTypedData(typed)) {
      deny('Polymarket typed data is denied and cannot be enabled by config', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const permit = permitKind(typed);
    if (permit) {
      if (!this.explicitAllows.has(permit)) {
        deny(`${permit === 'permit2' ? 'Permit2' : 'Permit'} typed data is denied unless explicitly allowed`, EvalancheErrorCode.SIGNER_REJECTED);
      }
      const amount = permitAmount(typed);
      if (amount === null) deny('Permit value could not be decoded', EvalancheErrorCode.SIGNER_REJECTED);
      if (amount >= (1n << 160n) - 1n) deny('Unlimited permit is denied', EvalancheErrorCode.SIGNER_REJECTED);
      if (intent.amountIn === undefined || amount !== BigInt(intent.amountIn)) {
        deny('decoded permit amount does not equal amountIn', EvalancheErrorCode.SIGNER_REJECTED);
      }
      const owner = typedParty(typed, 'owner');
      if (!owner || getAddress(owner) !== this.address) {
        deny('Permit owner is not the signer wallet', EvalancheErrorCode.SIGNER_REJECTED);
      }
      const spender = typedParty(typed, 'spender');
      if (!spender) deny('Permit spender could not be decoded', EvalancheErrorCode.SIGNER_REJECTED);
      if (!this.hasRole(Number(request.chainId), spender, 'spender')) {
        deny('Permit spender is not allowlisted', EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
    const match = (this.options.typedDataAllow ?? []).find((entry) => typedDataAllowed(entry, typed));
    if (!match) deny('typed-data signing is disabled unless the domain and type are allowlisted', EvalancheErrorCode.SIGNER_REJECTED);
  }

  private allowEntry(chainId: number, to: string | null | undefined): AllowEntry | undefined {
    if (!to) return undefined;
    let address: string;
    try {
      address = getAddress(to);
    } catch {
      deny('to is not an address', EvalancheErrorCode.INVALID_PARAMS);
    }
    return this.allow.get(chainId)?.find((entry) => getAddress(entry.address) === address);
  }

  private hasRole(chainId: number, address: string, role: AllowRole): boolean {
    return Boolean(this.allowEntry(chainId, address)?.roles?.includes(role));
  }

  private chainFor(chainId: number): ResolvedChain | undefined {
    return this.chainPolicy.chains.get(chainId);
  }

  /** Calls the module decoder owns. The generic selector allowlist does not apply. */
  private moduleHandles(request: CanonicalSigningRequest): boolean {
    if (!request.to) return false;
    const chain = this.chainFor(Number(request.chainId));
    if (!chain) return false;
    const data = request.data ?? '0x';
    const clmmOn = chain.clmm?.enabled === true && chain.chainId === CLMM_CHAIN_ID;
    if (clmmOn && (isClmmPositionManager(request.to) || isClmmNpmApprove(request.to, data))) return true;
    if (chain.dex?.enabled === true && isDexRouter(chain.chainId, request.to)) return true;
    if (chain.polymarket?.enabled === true && chain.chainId === PM_CHAIN_ID) {
      if (isHardDeniedContract(request.to) || isPolymarketCollateralApprove(request.to, data)) return true;
    }
    if (cctpModuleHandles(chain.chainId, request.to, data, chain.cctp)) return true;
    if (revokeOnlyEnabled(chain.revokeOnly) && isRevokeOnlySelector(data) && this.revokeTokenInScope(chain.chainId, request.to)) {
      return true;
    }
    return false;
  }

  /**
   * When the Avalanche CLMM module is on, WAVAX and USDC can be approved to
   * the position manager. A swap still spends them through the existing
   * allow map. This does not add the ERC-20 transfer selector, and it leaves
   * a transfer selector the operator already configured in place. Disabled
   * leaves the allow map unchanged.
   */
  private augmentClmmAllow(): void {
    const chain = this.chainPolicy.chains.get(CLMM_CHAIN_ID);
    if (chain?.clmm?.enabled !== true) return;
    const { wavax, usdc } = clmmFundingTokens();
    const approve = '0x095ea7b3';
    const entries = this.allow.get(CLMM_CHAIN_ID) ?? [];
    for (const token of [wavax, usdc]) {
      const existing = entries.find((entry) => getAddress(entry.address) === token);
      if (existing) {
        if (!existing.selectors.includes(approve)) existing.selectors.push(approve);
        const roles = new Set(existing.roles ?? []);
        roles.add('token');
        existing.roles = [...roles];
        if (existing.decimals === undefined) existing.decimals = token === usdc ? 6 : 18;
      } else {
        entries.push({
          address: token,
          selectors: [approve],
          decimals: token === usdc ? 6 : 18,
          roles: ['token'],
        });
      }
    }
    this.allow.set(CLMM_CHAIN_ID, entries);
  }

  private assertPolymarketKind(request: CanonicalSigningRequest, intent: SigningIntent): void {
    const chain = this.chainFor(Number(request.chainId));
    if (chain?.polymarket?.enabled !== true || Number(request.chainId) !== PM_CHAIN_ID) {
      deny('Polymarket is denied and cannot be enabled by config', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const typed = request.typedData;
    if (!typed) deny('typedData is required', EvalancheErrorCode.INVALID_PARAMS);
    const route = computeTypedDataRouteHash(typed);
    if (route.toLowerCase() !== intent.routeHash.toLowerCase()) {
      deny('routeHash does not match the typed data', EvalancheErrorCode.APPROVAL_INVALID);
    }
    try {
      assertPolymarketOrder({
        config: chain.polymarket,
        typed,
        intent,
        wallet: this.address,
        now: Date.now(),
        orderHash: route,
        state: {
          hasHash: (hash) => this.nonces.hasOrderHash(hash),
          hasSalt: (salt) => this.nonces.hasOrderSalt(salt),
          countSince: (at) => this.nonces.ordersSince(at),
          spentSince: (at) => this.nonces.spentSince(at),
        },
      });
    } catch (error) {
      deny(error instanceof Error ? error.message : 'Polymarket order was rejected', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private assertClobAuthKind(request: CanonicalSigningRequest): void {
    const chain = this.chainFor(Number(request.chainId));
    const typed = request.typedData;
    if (!typed) deny('typedData is required', EvalancheErrorCode.INVALID_PARAMS);
    const intent = request.structuredIntent;
    if (intent) {
      const route = computeTypedDataRouteHash(typed);
      if (route.toLowerCase() !== intent.routeHash.toLowerCase()) {
        deny('routeHash does not match the typed data', EvalancheErrorCode.APPROVAL_INVALID);
      }
    }
    try {
      assertClobAuth({
        config: chain?.polymarket,
        typed,
        wallet: this.address,
        now: Date.now(),
        orderHash: computeTypedDataRouteHash(typed),
        state: {
          hasHash: (hash) => this.nonces.hasOrderHash(hash),
          hasSalt: (salt) => this.nonces.hasOrderSalt(salt),
          countSince: (at) => this.nonces.ordersSince(at),
          spentSince: (at) => this.nonces.spentSince(at),
        },
      });
    } catch (error) {
      deny(error instanceof Error ? error.message : 'clob-auth was rejected', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private noteModuleReplay(request: CanonicalSigningRequest): { orderHash?: string } {
    if ((request.kind !== 'polymarket-order' && request.kind !== 'clob-auth') || !request.typedData) return {};
    const orderHash = computeTypedDataRouteHash(request.typedData);
    const salt = request.kind === 'polymarket-order'
      ? decimalSalt(request.typedData.value?.salt)
      : String(request.typedData.value?.timestamp ?? '');
    const usdMicros = request.kind === 'polymarket-order' ? orderNotionalMicros(request.typedData.value) : undefined;
    this.nonces.noteOrder(orderHash, salt, Date.now(), request.kind === 'clob-auth' ? 'auth' : 'order', usdMicros);
    return { orderHash };
  }

  private allowReason(request: CanonicalSigningRequest): string {
    if (request.kind === 'polymarket-order') {
      return 'signed; expiration, nonce, feeRateBps, and taker are not signed and not enforced';
    }
    return 'signed';
  }

  private revokeTokenInScope(chainId: number, address: string): boolean {
    if (isHardDeniedContract(address)) return false;
    if (isKnownRevokeToken(chainId, address)) return true;
    return this.addressAllowed(chainId, address) || this.hasRole(chainId, address, 'token');
  }

  private addressAllowed(chainId: number, address: string): boolean {
    let checksum: string;
    try {
      checksum = getAddress(address);
    } catch {
      return false;
    }
    return this.allow.get(chainId)?.some((entry) => getAddress(entry.address) === checksum) ?? false;
  }

  private decode(request: CanonicalSigningRequest, intent: SigningIntent): DecodedCall[] {
    const chainId = Number(request.chainId);
    const chain = this.chainFor(chainId);
    let decoded: DecodedCall[];
    try {
      decoded = decodeCalldata(request.to ?? '', request.data ?? '0x', {
        wallet: this.address,
        value: BigInt(request.value ?? '0'),
        explicitAllows: this.explicitAllows,
        tokenIn: intent.tokenIn?.address,
        tokenOut: intent.tokenOut?.address,
        amountIn: intent.amountIn === undefined ? undefined : BigInt(intent.amountIn),
        allowAddress: (address) => this.addressAllowed(chainId, address),
        allowRole: (address, role) => this.hasRole(chainId, address, role),
        allowSelector: (to, selector) => {
          const entry = this.allowEntry(chainId, to);
          return Boolean(entry?.selectors.includes(selector.toLowerCase()));
        },
        kyberExecutors: chain?.kyberExecutors ?? this.options.kyberExecutors,
        lifiDiamond: chain?.lifiDiamond,
        polymarket: chain?.polymarket,
        revokeOnly: chain?.revokeOnly,
        cctp: chain?.cctp,
        clmm: chain?.clmm,
        chainId,
        dex: chain?.dex,
        nowSec: Math.floor(Date.now() / 1000),
        intent,
        underlyingOf: (vault) => this.allowEntry(chainId, vault)?.underlying,
      });
    } catch (error) {
      deny(error instanceof Error ? error.message : 'Calldata could not be decoded', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const moduleCall = (call: DecodedCall) => call.kind === 'polymarket-call' || call.kind === 'clmm-call';
    const spends = decoded.filter((call) => !moduleCall(call) && call.kind !== 'erc20-approve' && call.kind !== 'erc20-increase-allowance' && call.kind !== 'erc2612-permit' && call.kind !== 'permit2');
    const approvals = decoded.filter((call) => !moduleCall(call) && (call.kind === 'erc20-approve' || call.kind === 'erc20-increase-allowance' || call.kind === 'erc2612-permit' || call.kind === 'permit2'));
    if (spends.length > 0) this.assertAmount(sumAmounts(spends), intent.amountIn, 'decoded amount');
    for (const call of approvals) this.assertAmount(call.amount, intent.amountIn, 'decoded approval amount');
    for (const call of decoded) {
      if (call.receiver && call.receiver !== this.address) {
        deny('decoded receiver is not the signer wallet', EvalancheErrorCode.SIGNER_REJECTED);
      }
      if (call.owner && call.owner !== this.address) {
        deny('decoded owner is not the signer wallet', EvalancheErrorCode.SIGNER_REJECTED);
      }
      if (call.minOut !== undefined) {
        if (intent.minAmountOut === undefined) deny('minAmountOut bound is required for this action', EvalancheErrorCode.APPROVAL_INVALID);
        if (call.minOut < BigInt(intent.minAmountOut)) {
          deny('decoded minOut is below intent minAmountOut', EvalancheErrorCode.SIGNER_REJECTED);
        }
        this.enforceV3Slippage(call, intent, chainId);
      }
    }
    if (actionRequiresMinAmountOut(intent.action) && !decoded.some((call) => call.minOut !== undefined)) {
      deny('minAmountOut bound is required for this action', EvalancheErrorCode.APPROVAL_INVALID);
    }
    const movesToken = decoded.some((call) => call.kind === 'erc20-transfer' || call.kind === 'erc20-approve' || call.kind === 'erc20-increase-allowance');
    if (movesToken) {
      if (!intent.tokenIn) deny('token intent is missing tokenIn', EvalancheErrorCode.APPROVAL_INVALID);
      if (getAddress(request.to ?? '') !== getAddress(intent.tokenIn.address)) {
        deny('transaction token does not match intent tokenIn', EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
    return decoded;
  }

  private enforceV3Slippage(call: DecodedCall, intent: SigningIntent, chainId: number): void {
    if (call.minOut === undefined) return;
    const direct = call.kind === 'dex-swap';
    if (!direct && !isLifiV3Selector(call.selector)) return;
    const chain = this.chainFor(chainId);
    const classBps = tokenClassBps(
      chain?.slippageCaps ?? this.options.slippageCaps,
      intent.tokenOut?.address,
      chain?.avalancheSlippageDefaults ?? true,
    );
    if (intent.maxSlippageBps !== undefined && intent.maxSlippageBps > classBps) {
      deny(`maxSlippageBps exceeds the ${classBps} bps token class slippage cap`, EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (intent.quotedAmountOut === undefined) {
      deny(
        direct ? 'quotedAmountOut is required for a direct DEX swap' : 'quotedAmountOut is required for a Li.Fi V3 swap',
        EvalancheErrorCode.SIGNER_REJECTED,
      );
    }
    const quoted = BigInt(intent.quotedAmountOut);
    if (quoted <= 0n) deny('quotedAmountOut must be greater than zero', EvalancheErrorCode.SIGNER_REJECTED);
    const outAddress = intent.tokenOut?.address;
    if (outAddress) {
      let capped = outAddress;
      try {
        capped = getAddress(outAddress);
      } catch {
        capped = outAddress;
      }
      const cap = chain ? tokenCap(chain, capped) : undefined;
      if (cap !== undefined && quoted > BigInt(cap)) {
        deny('quotedAmountOut exceeds the configured token cap', EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
    const bps = intent.maxSlippageBps ?? classBps;
    const floor = quoted * (10_000n - BigInt(bps)) / 10_000n;
    if (floor <= 0n) {
      deny('quotedAmountOut is too small to leave a positive token-unit slippage floor', EvalancheErrorCode.SIGNER_REJECTED);
    }
    if (call.minOut < floor) {
      deny('decoded minOut is below the quoted slippage floor', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private assertAmount(amount: bigint | undefined, reported: string | undefined, label: string): void {
    if (amount === undefined) deny(`${label} could not be decoded`, EvalancheErrorCode.SIGNER_REJECTED);
    if (reported === undefined) deny(`${label} requires amountIn`, EvalancheErrorCode.SIGNER_REJECTED);
    if (amount !== BigInt(reported)) deny(`${label} does not equal amountIn`, EvalancheErrorCode.SIGNER_REJECTED);
  }

  private async enforceEconomics(request: CanonicalSigningRequest, decoded: DecodedCall[]): Promise<void> {
    if (this.policy && request.kind === 'transaction' && request.to) {
      const result = this.policy.evaluate({
        to: request.to,
        from: this.address,
        value: request.value ?? '0',
        data: request.data,
        chainId: Number(request.chainId),
        gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
      });
      if (!result.allowed) {
        deny(`Spending policy rejected the transaction: ${result.reason}`, EvalancheErrorCode.POLICY_VIOLATION);
      }
    }
    const chainId = Number(request.chainId);
    const chain = this.chainFor(chainId);
    const nativeValue = BigInt(request.value && request.value.length > 0 ? request.value : '0');
    const nativeCap = chain ? tokenCap(chain, 'native') ?? tokenCap(chain, NATIVE_ADDRESS) : undefined;
    if (nativeCap !== undefined && nativeValue > BigInt(nativeCap)) {
      deny('Transaction value exceeds the native token cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
    }
    const spends = this.pricedSpends(request, decoded, chain);
    const byAsset = new Map<string, bigint>();
    for (const spend of spends) {
      byAsset.set(spend.address, (byAsset.get(spend.address) ?? 0n) + spend.amount);
    }
    for (const [address, amount] of byAsset) {
      if (address === NATIVE_ADDRESS) continue;
      const cap = chain ? tokenCap(chain, address) : undefined;
      if (cap !== undefined && amount > BigInt(cap)) {
        deny('Decoded token amount exceeds the configured per-transaction cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
      }
    }
    if (request.kind === 'transaction' && chain?.maxFeeUsd !== undefined) {
      await this.enforceGasUsd(request, chain);
    }
    if (this.options.maxPerTxUsd !== undefined && request.kind === 'transaction') {
      let micros = 0n;
      let nativeCounted = false;
      for (const [address, amount] of byAsset) {
        const native = address === NATIVE_ADDRESS;
        if (native) nativeCounted = true;
        const price = await this.priceOf(chainId, address);
        if (price === null) deny(`No price for ${address}; refusing to sign without a cap`, EvalancheErrorCode.SIGNER_REJECTED);
        const decimals = native ? 18 : this.allowEntry(Number(request.chainId), address)?.decimals;
        if (decimals === undefined) deny(`No configured decimals for ${address}; refusing to price the decoded amount`, EvalancheErrorCode.SIGNER_REJECTED);
        micros += usdMicros(amount, decimals, price);
      }
      if (!nativeCounted && nativeValue > 0n) {
        const price = await this.priceOf(chainId, NATIVE_ADDRESS);
        if (price === null) deny('No price for native value; refusing to sign without a cap', EvalancheErrorCode.SIGNER_REJECTED);
        micros += usdMicros(nativeValue, 18, price);
      }
      const capMicros = BigInt(Math.round(this.options.maxPerTxUsd * 1_000_000));
      if (micros > capMicros) deny('Decoded amount exceeds the per-transaction USD cap (oversize)', EvalancheErrorCode.SIGNER_REJECTED);
    }
  }

  private async enforceGasUsd(request: CanonicalSigningRequest, chain: ResolvedChain): Promise<void> {
    if (chain.maxFeeUsd === undefined) return;
    const limit = BigInt(request.gasLimit && request.gasLimit.length > 0 ? request.gasLimit : '0');
    const gasPrice = BigInt(request.gasPrice && request.gasPrice.length > 0 ? request.gasPrice : '0');
    const maxFee = BigInt(request.maxFeePerGas && request.maxFeePerGas.length > 0 ? request.maxFeePerGas : '0');
    const priceWei = gasPrice > maxFee ? gasPrice : maxFee;
    const cost = limit * priceWei;
    const price = await this.priceOf(chain.chainId, NATIVE_ADDRESS);
    if (price === null) deny('No price for native gas; refusing to sign without a cap', EvalancheErrorCode.SIGNER_REJECTED);
    const micros = usdMicros(cost, 18, price);
    const capMicros = BigInt(Math.round(chain.maxFeeUsd * 1_000_000));
    if (micros > capMicros) deny('gas cost exceeds the USD cap', EvalancheErrorCode.SIGNER_REJECTED);
  }

  private pricedSpends(
    request: CanonicalSigningRequest,
    decoded: DecodedCall[],
    chain: ResolvedChain | undefined,
  ): Array<{ address: string; amount: bigint }> {
    const capsOn = Object.keys(chain?.tokenCaps ?? {}).length > 0 || this.options.maxPerTxUsd !== undefined;
    const spends: Array<{ address: string; amount: bigint }> = [];
    for (const call of decoded) {
      if (call.amount === undefined) continue;
      if (!call.asset) {
        if (capsOn && call.kind === 'erc4626-deposit') {
          deny('vault underlying is not configured; refusing to price the vault', EvalancheErrorCode.SIGNER_REJECTED);
        }
        continue;
      }
      spends.push({ address: canonicalAsset(call.asset), amount: call.amount });
    }
    void request;
    return spends;
  }

  private async persistBudget(): Promise<void> {
    if (!this.policy) return;
    const body = JSON.stringify({ version: 1, records: this.policy.exportHistory() });
    await writeDurable(budgetPath(this.options.nonceStorePath), `${body}\n`);
  }

  private async priceOf(chainId: number, address: string): Promise<number | null> {
    const chain = this.chainFor(chainId);
    if (chain?.priceIds && !priceIdListed(chain.priceIds, address) && !this.feedPricesNative(chain, address)) return null;
    const prices = await this.pricesFor(chain);
    const value = prices[getAddress(address).toLowerCase()];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** The CoinGecko native id still prices gas when `price.ids` omits `native`. */
  private feedPricesNative(chain: ResolvedChain, address: string): boolean {
    if (!chain.priceFeed) return false;
    if (address !== NATIVE_ADDRESS && address !== 'native') return false;
    return nativeCoinGeckoId(chain.chainId, chain.priceIds) !== undefined;
  }

  private async pricesFor(chain: ResolvedChain | undefined): Promise<Record<string, number>> {
    const local = this.chainPolicy.legacy
      ? addressPrices(this.options.prices)
      : { ...(chain?.localPrices ?? {}) };
    if (chain?.priceFeed) {
      const remote = await this.coinGeckoPrices(chain, local);
      return { ...local, ...remote };
    }
    const source = this.chainPolicy.legacy
      ? (chain?.sanitySource ?? this.options.priceSourceUrl)
      : chain?.sanitySource;
    if (!source) return local;
    const ttl = this.options.priceTtlMs ?? DEFAULT_PRICE_TTL_MS;
    const now = Date.now();
    const cacheKey = this.chainPolicy.legacy ? source : `${chain?.chainId ?? 'none'}|${source}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < ttl) return { ...local, ...cached.prices };
    let response: Response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      deny(`Price source request failed: ${error instanceof Error ? error.message : String(error)}`, EvalancheErrorCode.NETWORK_ERROR);
    }
    if (!response.ok) deny('Price source request failed', EvalancheErrorCode.NETWORK_ERROR);
    const body = await response.json() as Record<string, unknown>;
    const table = (body.prices && typeof body.prices === 'object' ? body.prices : body) as Record<string, unknown>;
    const remote: Record<string, number> = {};
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      try {
        remote[getAddress(key).toLowerCase()] = value;
      } catch {
        // Symbol keys are ignored. Prices are by address only.
      }
    }
    this.priceCache.set(cacheKey, { fetchedAt: now, prices: remote });
    return { ...local, ...remote };
  }

  private async coinGeckoPrices(
    chain: ResolvedChain,
    references: Record<string, number>,
  ): Promise<Record<string, number>> {
    const feed = chain.priceFeed;
    if (!feed) return {};
    let bindings;
    try {
      bindings = coinGeckoBindings(chain.chainId, chain.priceIds);
    } catch (error) {
      deny(error instanceof Error ? error.message : 'Price feed has no ids', EvalancheErrorCode.INVALID_CONFIG);
    }
    if (bindings.length === 0) deny('Price feed has no ids', EvalancheErrorCode.SIGNER_REJECTED);
    const ttl = this.options.priceTtlMs ?? DEFAULT_PRICE_TTL_MS;
    const now = Date.now();
    const cacheKey = `${chain.chainId}|coingecko|${feed.url}|${bindings.map((binding) => `${binding.address}=${binding.coinId}`).join(',')}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < ttl) return cached.prices;
    try {
      const remote = await fetchCoinGeckoSimplePrice({
        url: feed.url,
        bindings,
        maxAgeMs: feed.maxAgeMs,
        nowMs: now,
      });
      assertCoinGeckoPricePlausible(remote, chain.priceBounds, references);
      this.priceCache.set(cacheKey, { fetchedAt: now, prices: remote });
      return remote;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Price feed request failed';
      const code = message.startsWith('Price feed request failed')
        ? EvalancheErrorCode.NETWORK_ERROR
        : EvalancheErrorCode.SIGNER_REJECTED;
      deny(message, code);
    }
  }

  private async simulate(request: CanonicalSigningRequest): Promise<void> {
    if (!request.to) deny('Transaction is missing to; refusing to sign', EvalancheErrorCode.SIMULATION_FAILED);
    const simulate = await this.simulator(Number(request.chainId));
    const result = await simulate({
      from: this.address,
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

  private async simulator(chainId: number): Promise<(tx: PendingTransaction) => Promise<SimulationResult>> {
    if (this.injectedSimulate) return this.injectedSimulate;
    const cached = this.rpcSimulators.get(chainId);
    if (cached) return cached;
    const chain = this.chainFor(chainId);
    const urls = chain && chain.rpcUrls.length > 0
      ? rpcUrlsFor(chain)
      : (this.options.rpcUrl ? [this.options.rpcUrl] : []);
    if (urls.length === 0) deny('Simulation requires rpcUrl or an injected simulator', EvalancheErrorCode.SIMULATION_FAILED);
    const fn = async (tx: PendingTransaction): Promise<SimulationResult> => {
      let last: SimulationResult = { success: false, revertReason: 'no rpc' };
      for (let index = 0; index < urls.length; index += 1) {
        const provider = new JsonRpcProvider(urls[index]);
        const result = await simulateTransaction(provider, tx);
        last = result;
        if (result.success) return result;
        if (!isTransportFailure(result.revertReason) || index === urls.length - 1) return result;
      }
      return last;
    };
    this.rpcSimulators.set(chainId, fn);
    return fn;
  }

  private async produce(request: CanonicalSigningRequest): Promise<SigningResult> {
    this.assertRunning();
    if (request.kind === 'transaction') {
      const type = request.type ?? 0;
      const tx: TransactionRequest = {
        to: request.to ?? undefined,
        value: BigInt(request.value ?? '0'),
        data: request.data ?? '0x',
        chainId: request.chainId,
        nonce: request.nonce,
        gasLimit: request.gasLimit ? BigInt(request.gasLimit) : undefined,
        type,
      };
      if (type === 2) {
        tx.maxFeePerGas = BigInt(request.maxFeePerGas ?? '0');
        tx.maxPriorityFeePerGas = BigInt(request.maxPriorityFeePerGas ?? '0');
      } else {
        tx.gasPrice = BigInt(request.gasPrice ?? '0');
      }
      this.assertRunning();
      const signedTransaction = await this.wallet.signTransaction(tx);
      return { requestId: request.requestId, signedTransaction };
    }
    if (request.kind === 'message') {
      this.assertRunning();
      const signature = await this.wallet.signMessage(toUtf8Bytes((request.message ?? '').normalize('NFC')));
      return { requestId: request.requestId, signature };
    }
    if (request.kind !== 'typed-data' && request.kind !== 'polymarket-order' && request.kind !== 'clob-auth') {
      deny('Unknown signing kind', EvalancheErrorCode.INVALID_PARAMS);
    }
    const typed = request.typedData;
    if (!typed) deny('typedData is required', EvalancheErrorCode.INVALID_PARAMS);
    this.assertRunning();
    const signature = await this.wallet.signTypedData(typed.domain as never, typed.types as never, typed.value);
    return { requestId: request.requestId, signature };
  }

  private async loadAudit(): Promise<void> {
    let raw = '';
    try {
      raw = await readFile(this.options.auditLogPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    let prev = AUDIT_ROOT;
    for (const line of lines) {
      let parsed: { prevHash?: string };
      try {
        parsed = JSON.parse(line) as { prevHash?: string };
      } catch {
        throw new EvalancheError('Audit log is not append-only JSONL', EvalancheErrorCode.INVALID_CONFIG);
      }
      if (parsed.prevHash !== prev) {
        throw new EvalancheError('Audit log prevHash chain does not link to the root', EvalancheErrorCode.INVALID_CONFIG);
      }
      prev = lineHash(line);
    }
    this.prevHash = prev;
  }

  private async audit(entry: Omit<AuditEntry, 'timestamp' | 'prevHash'>): Promise<void> {
    const lineObject: AuditEntry = {
      prevHash: this.prevHash,
      timestamp: new Date().toISOString(),
      ...entry,
      reason: stripUrls(entry.reason),
    };
    const line = JSON.stringify(lineObject);
    await mkdir(dirname(this.options.auditLogPath), { recursive: true });
    const handle = await openFile(this.options.auditLogPath, 'a', 0o600);
    try {
      await handle.write(`${line}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.prevHash = lineHash(line);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.halted) {
      sendJson(res, 503, { error: this.haltReason, code: 'INVALID_CONFIG' });
      return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, mode: this.options.dryRun ? 'dry-run' : 'live' });
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
      const message = stripUrls(error instanceof Error ? error.message : String(error));
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
      if (this.halted) {
        sendJson(res, 503, { error: this.haltReason, code: 'INVALID_CONFIG' });
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      if (this.halted) {
        sendJson(res, 503, { error: this.haltReason, code: 'INVALID_CONFIG' });
        return;
      }
      const message = stripUrls(error instanceof Error ? error.message : String(error));
      const code = error instanceof SignerRejection ? error.code : EvalancheErrorCode.SIGNER_REJECTED;
      const status = code === EvalancheErrorCode.INVALID_PARAMS ? 400 : 403;
      sendJson(res, status, { error: message, code });
    }
  }
}

function requestTx(request: CanonicalSigningRequest): ApprovedTransaction {
  let to = '';
  try {
    if (request.to) to = getAddress(request.to);
  } catch {
    deny('to is not an address', EvalancheErrorCode.INVALID_PARAMS);
  }
  const data = (request.data && request.data.length > 0 ? request.data : '0x').toLowerCase();
  return {
    to,
    value: request.value ?? '',
    data,
    chainId: Number(request.chainId),
    nonce: request.nonce === undefined || request.nonce === null ? '' : String(request.nonce),
    gasLimit: request.gasLimit ?? '',
    maxFeePerGas: request.maxFeePerGas ?? '',
    maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? '',
    gasPrice: request.gasPrice ?? '',
    type: request.type === undefined ? Number.NaN : Number(request.type),
  };
}

function assertGas(tx: ApprovedTransaction, cap: bigint): void {
  const limit = BigInt(tx.gasLimit);
  const price = BigInt(tx.gasPrice) > BigInt(tx.maxFeePerGas) ? BigInt(tx.gasPrice) : BigInt(tx.maxFeePerGas);
  if (limit <= 0n || price < 0n) deny('gas cost is not bounded', EvalancheErrorCode.SIGNER_REJECTED);
  const cost = limit * price;
  if (cost > HARD_MAX_GAS_COST_WEI) deny('gas cost exceeds the hard cap', EvalancheErrorCode.SIGNER_REJECTED);
  if (cost > cap) deny('gas cost exceeds the cap', EvalancheErrorCode.SIGNER_REJECTED);
}

function resolveGasCap(configured: string | undefined): bigint {
  if (configured === undefined) return DEFAULT_MAX_GAS_COST_WEI;
  if (!/^(0|[1-9][0-9]*)$/.test(configured)) {
    throw new EvalancheError('maxGasCostWei must be a decimal string', EvalancheErrorCode.INVALID_CONFIG);
  }
  const value = BigInt(configured);
  if (value > HARD_MAX_GAS_COST_WEI) {
    throw new EvalancheError('maxGasCostWei cannot exceed the hard gas-cost cap', EvalancheErrorCode.INVALID_CONFIG);
  }
  return value;
}

const ALLOW_ROLES = new Set<AllowRole>(['dex', 'spender', 'recipient', 'token', 'vault']);

function indexAllow(allow: Record<string, AllowEntry[]>): Map<number, AllowEntry[]> {
  const map = new Map<number, AllowEntry[]>();
  for (const [chain, entries] of Object.entries(allow ?? {})) {
    const chainId = Number(chain);
    if (!Number.isSafeInteger(chainId) || !Array.isArray(entries) || entries.length === 0) continue;
    const normalized = entries.map((entry) => ({
      address: getAddress(entry.address),
      selectors: (entry.selectors ?? []).map((selector) => selector.toLowerCase()),
      decimals: entry.decimals,
      underlying: entry.underlying ? getAddress(entry.underlying) : undefined,
      roles: normalizeRoles(entry.roles),
    })).filter((entry) => entry.selectors.length > 0 || entry.roles.length > 0);
    if (normalized.length > 0) map.set(chainId, normalized);
  }
  return map;
}

function normalizeRoles(roles: AllowRole[] | undefined): AllowRole[] {
  if (!Array.isArray(roles)) return [];
  const out: AllowRole[] = [];
  for (const role of roles) {
    if (ALLOW_ROLES.has(role) && !out.includes(role)) out.push(role);
  }
  return out;
}

function assertStartup(options: SignerServerOptions): void {
  if (!options.token) throw new EvalancheError('Signer auth token is required', EvalancheErrorCode.INVALID_CONFIG);
  if (!options.verifierPublicKey) throw new EvalancheError('Pinned verifier public key is required', EvalancheErrorCode.INVALID_CONFIG);
  try {
    assertEd25519PublicKey(options.verifierPublicKey);
  } catch (error) {
    throw new EvalancheError(
      error instanceof Error ? error.message : 'Verifier public key is rejected',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  if (!options.auditLogPath || !options.nonceStorePath) {
    throw new EvalancheError('auditLogPath and nonceStorePath are required', EvalancheErrorCode.INVALID_CONFIG);
  }
  if (!options.allow || indexAllow(options.allow).size === 0) {
    throw new EvalancheError(
      'A non-empty allow map {chainId -> [{address, selectors}]} is required',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  assertSlippageCaps(options.slippageCaps);
  assertKyberExecutors(options.kyberExecutors);
  const policy = resolveSignerPolicy(options, {
    defaultMaxFeeWei: DEFAULT_MAX_GAS_COST_WEI,
    hardMaxFeeWei: HARD_MAX_GAS_COST_WEI,
  });
  for (const chain of policy.chains.values()) {
    if (chain.polymarket?.enabled && chain.chainId !== PM_CHAIN_ID) {
      throw new EvalancheError('Polymarket module is only supported on chain 137', EvalancheErrorCode.INVALID_CONFIG);
    }
    assertPolymarketConfig(chain.polymarket, `chains.${chain.chainId}.polymarket`);
    assertRevokeOnlyConfig(chain.revokeOnly, `chains.${chain.chainId}.revokeOnly`);
    assertCctpConfig(chain.cctp, chain.chainId, chain.tokenCaps, `chains.${chain.chainId}.cctp`);
    assertClmmConfig(chain.clmm, chain.chainId);
    assertDexConfig(chain.dex, chain.chainId);
  }
  if (!policy.legacy) assertEnabledChainsReady(options, policy);
}

function assertEnabledChainsReady(options: SignerServerOptions, policy: SignerPolicy): void {
  const allow = indexAllow(options.allow);
  for (const chain of policy.chains.values()) {
    if (!chain.enabled) continue;
    const label = `chains.${chain.chainId}`;
    if (chain.tokenCaps.native === undefined) {
      throw new EvalancheError(`${label} is missing a native cap`, EvalancheErrorCode.INVALID_CONFIG);
    }
    for (const entry of allow.get(chain.chainId) ?? []) {
      if (!entry.roles?.includes('token')) continue;
      if (tokenCap(chain, entry.address) === undefined) {
        throw new EvalancheError(`${label} is missing a cap for ${entry.address}`, EvalancheErrorCode.INVALID_CONFIG);
      }
    }
    if (chain.clmm?.enabled === true && chain.chainId === CLMM_CHAIN_ID) {
      const { wavax, usdc } = clmmFundingTokens();
      for (const token of [wavax, usdc]) {
        if (tokenCap(chain, token) === undefined) {
          throw new EvalancheError(`${label} is missing a cap for ${token}`, EvalancheErrorCode.INVALID_CONFIG);
        }
      }
    }
    if (chain.dex?.enabled === true) {
      const wrapped = dexVenue(chain.chainId)?.wrappedNative;
      if (wrapped && tokenCap(chain, wrapped) === undefined) {
        throw new EvalancheError(`${label} is missing a cap for ${wrapped}`, EvalancheErrorCode.INVALID_CONFIG);
      }
    }
    if (chain.maxFeeUsd === undefined || !Number.isFinite(chain.maxFeeUsd) || chain.maxFeeUsd <= 0) {
      throw new EvalancheError(`${label}.gas.maxFeeUsd must be a positive number`, EvalancheErrorCode.INVALID_CONFIG);
    }
    const native = chain.localPrices?.[NATIVE_ADDRESS.toLowerCase()];
    const staticNative = typeof native === 'number' && Number.isFinite(native);
    const positiveNative = staticNative && native > 0;
    const nativeBound = chain.priceBounds?.[NATIVE_ADDRESS.toLowerCase()];
    const feedNative = Boolean(chain.priceFeed && nativeCoinGeckoId(chain.chainId, chain.priceIds));
    if (chain.priceFeed && !positiveNative && !nativeBound) {
      throw new EvalancheError(`${label}.price.priceFeed needs a native sanity bound`, EvalancheErrorCode.INVALID_CONFIG);
    }
    if (!chain.sanitySource && !staticNative && !feedNative) {
      throw new EvalancheError(`${label} is missing a native price or price.sanitySource`, EvalancheErrorCode.INVALID_CONFIG);
    }
  }
}

function assertKyberExecutors(list: string[] | undefined): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    throw new EvalancheError('kyberExecutors must be an address list', EvalancheErrorCode.INVALID_CONFIG);
  }
  for (const address of list) {
    try {
      getAddress(address);
    } catch {
      throw new EvalancheError('kyberExecutors has an invalid address', EvalancheErrorCode.INVALID_CONFIG);
    }
  }
}

function assertSlippageCaps(caps: SlippageCaps | undefined): void {
  if (!caps) return;
  const fields: Array<[string, number | undefined]> = [
    ['stableBps', caps.stableBps],
    ['topBps', caps.topBps],
    ['otherBps', caps.otherBps],
  ];
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      throw new EvalancheError(
        `slippageCaps.${name} must be an integer from 0 to 10000`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
  }
  for (const name of ['stables', 'top'] as const) {
    const list = caps[name];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new EvalancheError(`slippageCaps.${name} must be an address list`, EvalancheErrorCode.INVALID_CONFIG);
    }
    for (const address of list) {
      try {
        getAddress(address);
      } catch {
        throw new EvalancheError(`slippageCaps.${name} has an invalid address`, EvalancheErrorCode.INVALID_CONFIG);
      }
    }
  }
}

function addressInList(list: string[] | undefined, address: string): boolean {
  if (!list) return false;
  return list.some((entry) => {
    try {
      return getAddress(entry) === address;
    } catch {
      return false;
    }
  });
}

/** Bought-token class cap. Stables win over top. Unlisted tokens use the other cap. */
export function tokenClassBps(
  caps: SlippageCaps | undefined,
  tokenOut: string | undefined,
  avalancheDefaults = true,
): number {
  const stable = caps?.stableBps ?? DEFAULT_STABLE_SLIPPAGE_BPS;
  const top = caps?.topBps ?? DEFAULT_TOP_SLIPPAGE_BPS;
  const other = caps?.otherBps ?? DEFAULT_OTHER_SLIPPAGE_BPS;
  if (!tokenOut) return other;
  let address: string;
  try {
    address = getAddress(tokenOut);
  } catch {
    return other;
  }
  if ((avalancheDefaults && addressInList(DEFAULT_AVALANCHE_STABLES, address)) || addressInList(caps?.stables, address)) return stable;
  if ((avalancheDefaults && addressInList(DEFAULT_AVALANCHE_TOP, address)) || addressInList(caps?.top, address)) return top;
  return other;
}

async function assertFilePermissions(options: SignerServerOptions): Promise<string | undefined> {
  if (options.allowInsecureFilePermissions) return undefined;
  let keystore: string | undefined;
  if (options.configPath) {
    await assertSecureParents(options.configPath);
    await readSecureFile(options.configPath);
  }
  if (options.verifierPublicKeyPath) await assertSecureParents(options.verifierPublicKeyPath);
  if (options.keystorePath) {
    await assertSecureParents(options.keystorePath);
    keystore = await readSecureFile(options.keystorePath);
  }
  const stateOptions = options.trustAnchor ? { trustAnchor: options.trustAnchor } : undefined;
  const nonceDir = dirname(options.nonceStorePath);
  await assertSignerStateDirectory(nonceDir, stateOptions);
  const auditDir = dirname(options.auditLogPath);
  if (auditDir !== nonceDir) await assertSignerStateDirectory(auditDir, stateOptions);
  await assertStateFileIfExists(options.nonceStorePath, stateOptions);
  await assertStateFileIfExists(options.auditLogPath, stateOptions);
  await assertStateFileIfExists(budgetPath(options.nonceStorePath), stateOptions);
  await assertStateFileIfExists(`${options.nonceStorePath}.lock`, stateOptions);
  if (options.socketPath) await assertSocketDirectory(dirname(options.socketPath));
  return keystore;
}

async function resolveVerifierKey(options: SignerServerOptions): Promise<SignerServerOptions> {
  if (!options.verifierPublicKeyPath) return options;
  const raw = options.allowInsecureFilePermissions
    ? await readFile(options.verifierPublicKeyPath, 'utf8')
    : await readSecureFile(options.verifierPublicKeyPath);
  const fromFile = parseVerifierKey(raw);
  if (options.verifierPublicKey && !keysEqual(options.verifierPublicKey, fromFile)) {
    throw new EvalancheError(
      'verifierPublicKey does not match the key read from verifierPublicKeyPath',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  return { ...options, verifierPublicKey: fromFile };
}

function parseVerifierKey(raw: string): string {
  const text = raw.trim();
  if (!text) throw new EvalancheError('Verifier public key file is empty', EvalancheErrorCode.INVALID_CONFIG);
  if (text.startsWith('{')) {
    let parsed: { publicKey?: unknown; verifierPublicKey?: unknown };
    try {
      parsed = JSON.parse(text) as { publicKey?: unknown; verifierPublicKey?: unknown };
    } catch {
      throw new EvalancheError('Verifier public key file is not valid JSON', EvalancheErrorCode.INVALID_CONFIG);
    }
    const key = parsed.publicKey ?? parsed.verifierPublicKey;
    if (typeof key !== 'string' || !key.trim()) {
      throw new EvalancheError('Verifier public key file has no public key', EvalancheErrorCode.INVALID_CONFIG);
    }
    return key.trim();
  }
  return text;
}

function budgetPath(nonceStorePath: string): string {
  return `${nonceStorePath}.budget.json`;
}

async function readBudget(nonceStorePath: string): Promise<SpendRecord[]> {
  const path = budgetPath(nonceStorePath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: { version?: unknown; records?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown; records?: unknown };
  } catch {
    throw new EvalancheError('Spend budget file is corrupt', EvalancheErrorCode.INVALID_CONFIG);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
    throw new EvalancheError('Spend budget file is corrupt', EvalancheErrorCode.INVALID_CONFIG);
  }
  return parsed.records.map((record) => {
    const entry = record as Partial<SpendRecord>;
    if (!entry || typeof entry.txHash !== 'string' || typeof entry.amount !== 'string' || typeof entry.to !== 'string' || typeof entry.chainId !== 'number' || typeof entry.timestamp !== 'number') {
      throw new EvalancheError('Spend budget file is corrupt', EvalancheErrorCode.INVALID_CONFIG);
    }
    return { txHash: entry.txHash, amount: entry.amount, to: entry.to, chainId: entry.chainId, timestamp: entry.timestamp };
  });
}

function sumAmounts(calls: DecodedCall[]): bigint {
  return calls.reduce((sum, call) => sum + (call.amount ?? 0n), 0n);
}

function usdMicros(amount: bigint, decimals: number, price: number): bigint {
  if (!Number.isFinite(price) || price < 0) deny('Price source returned a non-finite price', EvalancheErrorCode.SIGNER_REJECTED);
  const priceMicros = BigInt(Math.round(price * 1_000_000));
  const scale = 10n ** BigInt(decimals);
  return (amount * priceMicros) / scale;
}

function addressPrices(prices: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(prices ?? {})) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    try {
      out[getAddress(key).toLowerCase()] = value;
    } catch {
      // Ignore symbol keys.
    }
  }
  return out;
}

const HL_AGENT = [
  { name: 'source', type: 'string' },
  { name: 'connectionId', type: 'bytes32' },
];

function isPolymarketTypedData(typed: TypedDataPayload): boolean {
  if (/polymarket|ctf exchange/i.test(String(typed.domain?.name ?? ''))) return true;
  const contract = typed.domain?.verifyingContract;
  return typeof contract === 'string' && isHardDeniedContract(contract);
}

function isClobAuthTypedData(typed: TypedDataPayload): boolean {
  return String(typed.domain?.name ?? '').toLowerCase() === PM_CLOB_AUTH_DOMAIN.toLowerCase();
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function decimalSalt(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value).toString();
  return String(value ?? '');
}

/** Collateral units of a Polymarket order. BUY spends makerAmount. SELL spends takerAmount. */
function orderNotionalMicros(value: Record<string, unknown> | undefined): string {
  const side = BigInt(decimalSalt(value?.side) || '0');
  const maker = BigInt(decimalSalt(value?.makerAmount) || '0');
  const taker = BigInt(decimalSalt(value?.takerAmount) || '0');
  return (side === 0n ? maker : taker).toString();
}

function priceIdListed(ids: Record<string, string>, address: string): boolean {
  if (address === NATIVE_ADDRESS || address === 'native') return Object.prototype.hasOwnProperty.call(ids, 'native') || Object.prototype.hasOwnProperty.call(ids, NATIVE_ADDRESS);
  try {
    const checksum = getAddress(address);
    return Object.prototype.hasOwnProperty.call(ids, checksum)
      || Object.prototype.hasOwnProperty.call(ids, checksum.toLowerCase())
      || Object.prototype.hasOwnProperty.call(ids, address);
  } catch {
    return false;
  }
}

function isTransportFailure(reason: string | undefined): boolean {
  if (!reason) return true;
  if (/revert|execution|insufficient|allowance|transfer amount|custom error|panic/i.test(reason)) return false;
  return /timeout|timed out|network|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|SERVER_ERROR|bad gateway|503|502|429|unavailable|failed to detect network|could not coalesce|missing response/i.test(reason);
}

function typedParty(typed: TypedDataPayload, field: 'owner' | 'spender'): string | null {
  const value = typed.value?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isHyperliquidTypedData(typed: TypedDataPayload): boolean {
  const name = String(typed.domain?.name ?? '');
  const chainId = Number(typed.domain?.chainId ?? NaN);
  if (name === 'Exchange' && chainId === 1337) return true;
  if (name === 'HyperliquidSignTransaction' || /hyperliquid/i.test(name)) return true;
  for (const [typeName, fields] of Object.entries(typed.types ?? {})) {
    if (/hyperliquid/i.test(typeName) || /approveagent/i.test(typeName)) return true;
    if (typeName === 'Agent' && sameFields(fields, HL_AGENT)) return true;
  }
  return false;
}

function sameFields(actual: Array<{ name: string; type: string }> | undefined, expected: Array<{ name: string; type: string }>): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return expected.every((field, index) => actual[index]?.name === field.name && actual[index]?.type === field.type);
}

function permitAmount(typed: TypedDataPayload): bigint | null {
  const value = typed.value ?? {};
  if (value.value !== undefined && /^\d+$/.test(String(value.value))) return BigInt(String(value.value));
  const details = value.details as { amount?: string | number } | undefined;
  if (details && details.amount !== undefined && /^\d+$/.test(String(details.amount))) return BigInt(String(details.amount));
  return null;
}

function permitKind(typed: TypedDataPayload): 'permit' | 'permit2' | null {
  const domain = String(typed.domain?.name ?? '').toLowerCase();
  if (domain.includes('permit2')) return 'permit2';
  for (const name of Object.keys(typed.types ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'permit') return 'permit';
    if (lower.includes('permit')) return 'permit2';
  }
  return null;
}

function typedDataAllowed(entry: TypedDataAllow, typed: TypedDataPayload): boolean {
  if (String(typed.domain?.name ?? '') !== entry.domainName) return false;
  if (!Object.prototype.hasOwnProperty.call(typed.types ?? {}, entry.primaryType)) return false;
  if (entry.chainId !== undefined && Number(typed.domain?.chainId) !== entry.chainId) return false;
  if (entry.verifyingContract !== undefined) {
    try {
      if (getAddress(String(typed.domain?.verifyingContract)) !== getAddress(entry.verifyingContract)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Copy EVALANCHE_SIGNER_PRIVATE_KEY and remove it from the process environment
 * before any child is spawned. The value is not logged. An empty value is unset.
 * Deleting process.env does not wipe the process initial environ. See TM-008.
 */
function takeSignerEnvKey(): string | undefined {
  const value = process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
  if (value !== undefined) delete process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Copy EVALANCHE_SIGNER_TOKEN and remove it from process.env before any child
 * is spawned. The value is not logged. An empty value is unset. Deleting
 * process.env does not wipe the process initial environ. See TM-008.
 */
export function takeSignerEnvToken(): string | undefined {
  const value = process.env.EVALANCHE_SIGNER_TOKEN;
  if (value !== undefined) delete process.env.EVALANCHE_SIGNER_TOKEN;
  return value && value.length > 0 ? value : undefined;
}

/**
 * Halt the signer, close it, and exit. SIGTERM and SIGINT call this.
 * A server with beginShutdown halts before it closes sockets. A second call is ignored.
 */
export function attachSignerShutdown(
  server: {
    close(): Promise<void>;
    beginShutdown?: (exit: (code: number) => void, code?: number) => void;
  },
  exit: (code: number) => void = (code) => process.exit(code),
): { shutdown: () => void; dispose: () => void } {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (server.beginShutdown) {
      server.beginShutdown(exit, 0);
      return;
    }
    server.close().then(
      () => exit(0),
      () => exit(1),
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return {
    shutdown,
    dispose() {
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    },
  };
}

function walletFromSecret(secret: string, label: string): Wallet {
  try {
    return new Wallet(secret);
  } catch {
    throw new EvalancheError(`${label} is not a valid signer key`, EvalancheErrorCode.INVALID_CONFIG);
  }
}

async function loadSignerWallet(options: SignerServerOptions, keystoreJson?: string): Promise<Wallet | HDNodeWallet> {
  const envKey = takeSignerEnvKey();
  if (options.privateKey && options.keystorePath) {
    throw new EvalancheError('privateKey and keystorePath are mutually exclusive', EvalancheErrorCode.INVALID_CONFIG);
  }
  if (options.privateKey) return walletFromSecret(options.privateKey, 'privateKey');
  if (envKey && options.keystorePath) {
    throw new EvalancheError('EVALANCHE_SIGNER_PRIVATE_KEY and keystorePath are mutually exclusive', EvalancheErrorCode.INVALID_CONFIG);
  }
  if (envKey) return walletFromSecret(envKey, 'EVALANCHE_SIGNER_PRIVATE_KEY');
  if (options.keystorePath) {
    const envName = options.keystorePasswordEnv ?? 'EVALANCHE_SIGNER_KEYSTORE_PASSWORD';
    const password = process.env[envName];
    if (!password) throw new EvalancheError(`Keystore password env ${envName} is empty`, EvalancheErrorCode.INVALID_CONFIG);
    const json = keystoreJson ?? await readFile(options.keystorePath, 'utf8');
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
  try {
    const listening = await server.listen();
    return Object.assign(server, listening);
  } catch (error) {
    await server.close();
    throw error;
  }
}
