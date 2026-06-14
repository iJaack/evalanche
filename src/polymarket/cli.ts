import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

const execFile = promisify(execFileCallback);

export interface PolymarketCliRunnerOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}

export type PolymarketCliRunner = (
  binary: string,
  args: string[],
  options: PolymarketCliRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface PolymarketCliOptions {
  binary?: string;
  privateKey?: string;
  signatureType?: 'proxy' | 'eoa' | 'gnosis-safe' | string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  runner?: PolymarketCliRunner;
}

export interface PolymarketCliRunOptions {
  requiresPrivateKey?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function normalizePrivateKey(privateKey?: string): string | undefined {
  const value = String(privateKey ?? '').trim();
  if (!value) return undefined;
  return value.startsWith('0x') ? value : `0x${value}`;
}

function redact(value: string, privateKey?: string): string {
  let redacted = value;
  const normalized = normalizePrivateKey(privateKey);
  if (normalized) {
    redacted = redacted.split(normalized).join('[REDACTED_POLYMARKET_PRIVATE_KEY]');
    redacted = redacted.split(normalized.slice(2)).join('[REDACTED_POLYMARKET_PRIVATE_KEY]');
  }
  return redacted;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function buildMinimalEnv(privateKey: string | undefined, signatureType: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    POLYMARKET_SIGNATURE_TYPE: signatureType,
  };
  for (const name of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (privateKey) env.POLYMARKET_PRIVATE_KEY = privateKey;
  return env;
}

export class PolymarketCli {
  private readonly binary: string;
  private readonly privateKey?: string;
  private readonly signatureType: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly runner: PolymarketCliRunner;

  constructor(options: PolymarketCliOptions = {}) {
    this.binary = options.binary ?? process.env.EVALANCHE_POLYMARKET_CLI_BIN ?? 'polymarket';
    this.privateKey = normalizePrivateKey(options.privateKey ?? process.env.POLYMARKET_PRIVATE_KEY);
    this.signatureType = options.signatureType ?? process.env.POLYMARKET_SIGNATURE_TYPE ?? 'proxy';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.runner = options.runner ?? (async (binary, args, runOptions) => {
      const result = await execFile(binary, args, runOptions);
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    });
  }

  get command(): string {
    return this.binary;
  }

  async runJson(args: string[], options: PolymarketCliRunOptions = {}): Promise<unknown> {
    if (options.requiresPrivateKey && !this.privateKey) {
      throw new EvalancheError(
        'Official Polymarket CLI command requires a signer private key. Configure the Evalanche wallet or POLYMARKET_PRIVATE_KEY.',
        EvalancheErrorCode.SIGNER_NOT_FOUND,
      );
    }

    const cliArgs = ['-o', 'json', ...args];
    const env = buildMinimalEnv(this.privateKey, this.signatureType);

    try {
      const { stdout } = await this.runner(this.binary, cliArgs, {
        env,
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: this.maxBufferBytes,
      });
      return parseJsonOutput(stdout);
    } catch (error: any) {
      const code = error?.code;
      const stderr = redact(String(error?.stderr ?? ''), this.privateKey);
      const stdout = redact(String(error?.stdout ?? ''), this.privateKey);
      const message = redact(String(error?.message ?? error), this.privateKey);
      const detail = [stderr, stdout].filter(Boolean).join(' ').trim();

      if (code === 'ENOENT') {
        throw new EvalancheError(
          `Official Polymarket CLI binary not found: ${this.binary}. Install it with Homebrew or set EVALANCHE_POLYMARKET_CLI_BIN.`,
          EvalancheErrorCode.NOT_IMPLEMENTED,
          error instanceof Error ? error : undefined,
        );
      }

      throw new EvalancheError(
        `Official Polymarket CLI failed for "${this.binary} ${cliArgs.join(' ')}": ${detail || message}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  marketsList(limit: number, closed = false): Promise<unknown> {
    return this.runJson(['markets', 'list', '--limit', String(limit), '--closed', String(closed)]);
  }

  marketsSearch(query: string, limit: number): Promise<unknown> {
    return this.runJson(['markets', 'search', query, '--limit', String(limit)]);
  }

  market(idOrSlug: string): Promise<unknown> {
    return this.runJson(['markets', 'get', idOrSlug]);
  }

  clobMarket(conditionId: string): Promise<unknown> {
    return this.runJson(['clob', 'market', conditionId]);
  }

  orderBook(tokenId: string): Promise<unknown> {
    return this.runJson(['clob', 'book', tokenId]);
  }

  openOrders(tokenId?: string): Promise<unknown> {
    const args = ['clob', 'orders'];
    if (tokenId) args.push('--asset', tokenId);
    return this.runJson(args, { requiresPrivateKey: true });
  }

  order(orderId: string): Promise<unknown> {
    return this.runJson(['clob', 'order', orderId], { requiresPrivateKey: true });
  }

  cancelOrder(orderId: string): Promise<unknown> {
    return this.runJson(['clob', 'cancel', orderId], { requiresPrivateKey: true });
  }

  trades(tokenId?: string): Promise<unknown> {
    const args = ['clob', 'trades'];
    if (tokenId) args.push('--asset', tokenId);
    return this.runJson(args, { requiresPrivateKey: true });
  }

  balance(assetType: 'collateral' | 'conditional', tokenId?: string): Promise<unknown> {
    const args = ['clob', 'balance', '--asset-type', assetType];
    if (tokenId) args.push('--token', tokenId);
    return this.runJson(args, { requiresPrivateKey: true });
  }

  approveSet(): Promise<unknown> {
    return this.runJson(['approve', 'set'], { requiresPrivateKey: true, timeoutMs: 120_000 });
  }

  approveCheck(address?: string): Promise<unknown> {
    const args = ['approve', 'check'];
    if (address) args.push(address);
    return this.runJson(args, { requiresPrivateKey: true });
  }

  createOrder(params: {
    tokenId: string;
    side: 'buy' | 'sell';
    price: string | number;
    size: string | number;
    orderType?: 'GTC' | 'FOK' | 'GTD' | 'FAK' | string;
    postOnly?: boolean;
  }): Promise<unknown> {
    const args = [
      'clob',
      'create-order',
      '--token',
      params.tokenId,
      '--side',
      params.side,
      '--price',
      String(params.price),
      '--size',
      String(params.size),
      '--order-type',
      params.orderType ?? 'GTC',
    ];
    if (params.postOnly) args.push('--post-only');
    return this.runJson(args, { requiresPrivateKey: true });
  }

  marketOrder(params: {
    tokenId: string;
    side: 'buy' | 'sell';
    amount: string | number;
    orderType?: 'FOK' | 'FAK' | string;
  }): Promise<unknown> {
    return this.runJson([
      'clob',
      'market-order',
      '--token',
      params.tokenId,
      '--side',
      params.side,
      '--amount',
      String(params.amount),
      '--order-type',
      params.orderType ?? 'FOK',
    ], { requiresPrivateKey: true });
  }

  positions(walletAddress: string): Promise<unknown> {
    return this.runJson(['data', 'positions', walletAddress]);
  }

  bridgeDeposit(walletAddress: string): Promise<unknown> {
    return this.runJson(['bridge', 'deposit', walletAddress]);
  }

  bridgeStatus(depositAddress: string): Promise<unknown> {
    return this.runJson(['bridge', 'status', depositAddress]);
  }

  ctfRedeem(conditionId: string): Promise<unknown> {
    return this.runJson(['ctf', 'redeem', '--condition', conditionId], {
      requiresPrivateKey: true,
      timeoutMs: 120_000,
    });
  }
}
