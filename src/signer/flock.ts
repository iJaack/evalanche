/**
 * Exclusive lock for the nonce file.
 *
 * Darwin holds the lock with O_EXLOCK on a descriptor kept open in this
 * process. Linux execs the sha256-pinned helper shipped next to this module.
 * Nothing is compiled here, nothing is written under TMPDIR, and nothing is
 * looked up on PATH.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** sha256 of src/signer/helpers/flock-linux-x64. Rebuilds must update this pin. */
const LINUX_HELPER_SHA256 = '77770a0f1139a83066a30dadc08deb5a44e66e475a13276a5b2d9ea5feaf118f';
const HELPER_NAME = 'flock-linux-x64';

export interface HeldLock {
  release(): void;
}

export async function holdExclusiveLock(lockPath: string): Promise<HeldLock> {
  if (process.platform === 'darwin') return holdDarwin(lockPath);
  if (process.platform === 'linux') return holdLinux(lockPath);
  throw new EvalancheError(
    `exclusive lock is not available on ${process.platform}`,
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

function holdDarwin(lockPath: string): HeldLock {
  const exlock = (constants as { O_EXLOCK?: number }).O_EXLOCK;
  if (!exlock || constants.O_NONBLOCK === undefined) {
    throw new EvalancheError('O_EXLOCK is not available', EvalancheErrorCode.INVALID_CONFIG);
  }
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | exlock | constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = openSync(lockPath, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') locked(lockPath);
    throw new EvalancheError(
      `nonce lock failed: ${error instanceof Error ? error.message : 'open failed'}`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
    },
  };
}

function holdLinux(lockPath: string): Promise<HeldLock> {
  const helper = pinnedHelperPath();
  const child = spawn(helper, [lockPath], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveHeld, reject) => {
    let settled = false;
    let buf = '';
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG));
    };
    const timer = setTimeout(() => fail(`nonce lock helper timed out: ${lockPath}`), 3000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('ok') || settled) return;
      settled = true;
      clearTimeout(timer);
      let released = false;
      resolveHeld({
        release() {
          if (released) return;
          released = true;
          child.kill('SIGKILL');
        },
      });
    });
    child.on('error', (error) => fail(`nonce lock helper failed to start: ${error.message}`));
    child.on('exit', (code) => {
      if (settled) return;
      if (code === 2) fail(`nonce store is locked: ${lockPath}`);
      else fail(`nonce lock helper exited ${code ?? 'unknown'}: ${lockPath}`);
    });
  });
}

function pinnedHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'helpers', HELPER_NAME),
    join(here, 'signer', 'helpers', HELPER_NAME),
    join(process.cwd(), 'src', 'signer', 'helpers', HELPER_NAME),
  ];
  for (const candidate of candidates) {
    const bytes = readPinned(candidate);
    if (!bytes) continue;
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== LINUX_HELPER_SHA256) {
      throw new EvalancheError(
        `lock helper hash does not match the pinned digest: ${candidate}`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    return resolve(candidate);
  }
  throw new EvalancheError(
    'pinned Linux lock helper is missing from the package',
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

/** Read a regular file without following a final symlink. ENOENT returns null. */
function readPinned(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new EvalancheError(
      `lock helper cannot be read: ${path}`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new EvalancheError(`lock helper is not a regular file: ${path}`, EvalancheErrorCode.INVALID_CONFIG);
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function locked(lockPath: string): never {
  throw new EvalancheError(`nonce store is locked: ${lockPath}`, EvalancheErrorCode.INVALID_CONFIG);
}
