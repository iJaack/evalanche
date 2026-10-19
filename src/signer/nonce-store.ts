/**
 * Single-instance nonce store.
 *
 * The file is created only with --init-nonces. Every write is fsynced, and
 * the parent directory is fsynced after the rename. An exclusive kernel lock
 * on a lock file keeps a second signer from opening the same store. Darwin
 * uses O_EXLOCK (0x20). Linux execs the pinned helper from the descriptor
 * that was hashed. If that helper exits after the lock is held, the signer
 * stops. The kernel releases the lock when the helper dies. `startedAt` is recorded
 * at initialization; approvals created before that time are rejected.
 */

import { open, rename, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { holdExclusiveLock, type HeldLock, type HoldLockOptions } from './flock';

export interface WalletNonce {
  lastNonce: string;
  used: string[];
}

export interface PolymarketOrderRecord {
  hash: string;
  salt: string;
  at: number;
  /** `auth` is a one-use clob-auth and does not count toward the daily order cap. */
  kind?: 'order' | 'auth';
  /** Collateral micros of an order. Absent on older records, which do not count toward the USD ceiling. */
  usdMicros?: string;
}

interface NonceFile {
  version: 1;
  startedAt: number;
  wallets: Record<string, WalletNonce>;
  /** Last signed EOA transaction nonce, keyed by wallet then chain id. */
  txNonces?: Record<string, Record<string, string>>;
  polymarketOrders?: PolymarketOrderRecord[];
}

export class NonceStore {
  readonly startedAt: number;
  private readonly path: string;
  private readonly held: HeldLock;
  private wallets: Record<string, WalletNonce>;
  private txNonces: Record<string, Record<string, string>>;
  private orders: PolymarketOrderRecord[];
  private closed = false;

  private constructor(path: string, held: HeldLock, file: NonceFile) {
    this.path = path;
    this.held = held;
    this.startedAt = file.startedAt;
    this.wallets = file.wallets;
    this.txNonces = file.txNonces ?? {};
    this.orders = file.polymarketOrders ?? [];
  }

  static async open(path: string, initNonces: boolean, options: HoldLockOptions = {}): Promise<NonceStore> {
    await mkdir(dirname(path), { recursive: true });
    const held = await holdExclusiveLock(`${path}.lock`, options);
    try {
      const file = await loadOrInit(path, initNonces);
      return new NonceStore(path, held, file);
    } catch (error) {
      held.release();
      throw error;
    }
  }

  get(wallet: string): WalletNonce {
    return this.wallets[wallet] ?? { lastNonce: '-1', used: [] };
  }

  note(wallet: string, nonce: string): void {
    const entry = this.wallets[wallet] ?? { lastNonce: '-1', used: [] };
    entry.used.push(nonce);
    entry.lastNonce = nonce;
    this.wallets[wallet] = entry;
  }

  /** Records the proposer-chosen EOA nonce for one chain. Approval nonces stay global. */
  noteTxNonce(wallet: string, chainId: number, nonce: string): void {
    const byChain = this.txNonces[wallet] ?? {};
    byChain[String(chainId)] = nonce;
    this.txNonces[wallet] = byChain;
  }

  txNonce(wallet: string, chainId: number): string | undefined {
    return this.txNonces[wallet]?.[String(chainId)];
  }

  noteOrder(hash: string, salt: string, at: number, kind: 'order' | 'auth' = 'order', usdMicros?: string): void {
    const record: PolymarketOrderRecord = { hash, salt, at, kind };
    if (usdMicros !== undefined) record.usdMicros = usdMicros;
    this.orders.push(record);
  }

  hasOrderHash(hash: string): boolean {
    return this.orders.some((order) => order.hash === hash);
  }

  hasOrderSalt(salt: string): boolean {
    return this.orders.some((order) => order.kind !== 'auth' && order.salt === salt);
  }

  ordersSince(atMs: number): number {
    return this.orders.filter((order) => order.kind !== 'auth' && order.at >= atMs).length;
  }

  /** Sum of stored order notionals since `atMs`. A record with no `usdMicros` is not included. */
  spentSince(atMs: number): bigint {
    let sum = 0n;
    for (const order of this.orders) {
      if (order.kind === 'auth' || order.at < atMs || order.usdMicros === undefined) continue;
      sum += BigInt(order.usdMicros);
    }
    return sum;
  }

  /**
   * Orders since `atMs` that were stored before `usdMicros` existed.
   * The caller prices each one at `maxOrderUsd`. Auth records are not orders.
   */
  unpricedOrdersSince(atMs: number): number {
    let count = 0;
    for (const order of this.orders) {
      if (order.kind === 'auth' || order.at < atMs || order.usdMicros !== undefined) continue;
      count += 1;
    }
    return count;
  }

  async persist(): Promise<void> {
    const body: NonceFile = {
      version: 1,
      startedAt: this.startedAt,
      wallets: this.wallets,
      txNonces: this.txNonces,
      polymarketOrders: this.orders,
    };
    await writeDurable(this.path, `${JSON.stringify(body)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.held.release();
  }
}

async function loadOrInit(path: string, initNonces: boolean): Promise<NonceFile> {
  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const kind = raw === null ? 'missing' : classify(raw);
  if (kind === 'corrupt') {
    throw new EvalancheError(
      'Nonce store is corrupt. Refusing to reinitialize over existing nonce history.',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  if (kind === 'missing' || kind === 'empty') {
    if (!initNonces) {
      throw new EvalancheError(
        'Nonce store is missing or empty. Pass --init-nonces to create it. Refusing to start with a blank history.',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    const created: NonceFile = { version: 1, startedAt: Date.now(), wallets: {} };
    await writeDurable(path, `${JSON.stringify(created)}\n`);
    return created;
  }
  return JSON.parse(raw!) as NonceFile;
}

function classify(raw: string): 'empty' | 'valid' | 'corrupt' {
  if (!raw.trim()) return 'empty';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'corrupt';
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return 'empty';
  if (record.version === 1 && Number.isSafeInteger(record.startedAt) && record.wallets && typeof record.wallets === 'object') {
    return 'valid';
  }
  if (keys.length === 1 && record.wallets && typeof record.wallets === 'object' && Object.keys(record.wallets as object).length === 0) {
    return 'empty';
  }
  return 'corrupt';
}

export async function writeDurable(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

