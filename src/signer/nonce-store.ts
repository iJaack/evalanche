/**
 * Single-instance nonce store.
 *
 * The file is created only with --init-nonces. Every write is fsynced, and
 * the parent directory is fsynced after the rename. An exclusive lock file
 * keeps a second signer from opening the same store. `startedAt` is recorded
 * at initialization; approvals created before that time are rejected.
 */

import { open, rename, mkdir, readFile } from 'node:fs/promises';
import { closeSync, constants, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export interface WalletNonce {
  lastNonce: string;
  used: string[];
}

interface NonceFile {
  version: 1;
  startedAt: number;
  wallets: Record<string, WalletNonce>;
}

export class NonceStore {
  readonly startedAt: number;
  private readonly path: string;
  private readonly lockFd: number;
  private wallets: Record<string, WalletNonce>;
  private closed = false;

  private constructor(path: string, lockFd: number, file: NonceFile) {
    this.path = path;
    this.lockFd = lockFd;
    this.startedAt = file.startedAt;
    this.wallets = file.wallets;
  }

  static async open(path: string, initNonces: boolean): Promise<NonceStore> {
    const lockFd = acquireLock(`${path}.lock`);
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await loadOrInit(path, initNonces);
      return new NonceStore(path, lockFd, file);
    } catch (error) {
      releaseLock(lockFd, `${path}.lock`);
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

  async persist(): Promise<void> {
    const body: NonceFile = { version: 1, startedAt: this.startedAt, wallets: this.wallets };
    await writeDurable(this.path, `${JSON.stringify(body)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    releaseLock(this.lockFd, `${this.path}.lock`);
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

async function writeDurable(path: string, contents: string): Promise<void> {
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

function acquireLock(lockPath: string): number {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      writeSync(fd, String(process.pid));
      fsyncSync(fd);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = NaN;
      try {
        owner = Number(readFileSync(lockPath, 'utf8'));
      } catch {
        owner = NaN;
      }
      if (Number.isInteger(owner) && owner > 0 && pidAlive(owner)) {
        throw new EvalancheError(
          `Nonce store is locked by process ${owner}. Refusing to run a second signer.`,
          EvalancheErrorCode.INVALID_CONFIG,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // The owner may have released it between the checks.
      }
    }
  }
  throw new EvalancheError('Nonce store lock could not be acquired', EvalancheErrorCode.INVALID_CONFIG);
}

function releaseLock(fd: number, lockPath: string): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Another start may already have replaced a stale lock.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
