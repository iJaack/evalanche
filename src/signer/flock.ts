/**
 * Exclusive lock for the nonce file.
 *
 * Darwin holds the lock with O_EXLOCK (0x20) on a descriptor kept open in
 * this process. Node does not expose that flag. Linux opens the sha256-pinned
 * helper once, hashes that descriptor, and execs the same descriptor through
 * /proc/self/fd. The path is not opened again. Nothing is compiled here,
 * nothing is written under TMPDIR, and nothing is looked up on PATH.
 */

import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { assertSecureParents } from './secure-path';

/**
 * sha256 of src/signer/helpers/flock-linux-x64.
 * Rebuild with docker/flock-helper.Dockerfile and update this pin together
 * with the committed binary. The recipe is in that Dockerfile.
 */
const LINUX_HELPER_SHA256 = '3b5e994530bfac670bd893a5e14b399886a932bcdafbf850d02d56b5590803c6';
const HELPER_NAME = 'flock-linux-x64';
/** Darwin <sys/fcntl.h> O_EXLOCK. Absent from Node's fs.constants. */
const DARWIN_O_EXLOCK = 0x20;
/** Linux <asm-generic/fcntl.h> O_CLOEXEC. Absent from Node's fs.constants. */
const LINUX_O_CLOEXEC = 0x80000;

export interface HeldLock {
  release(): void;
}

export interface HoldLockOptions {
  /** Skip root-ownership checks. Tests only. The hash and fd exec still run. */
  allowInsecureFilePermissions?: boolean;
  /** Fires after the lock was acquired if the helper exits or errors. */
  onLockLost?: () => void;
}

export async function holdExclusiveLock(lockPath: string, options: HoldLockOptions = {}): Promise<HeldLock> {
  if (process.platform === 'darwin') return holdDarwin(lockPath);
  if (process.platform === 'linux') return holdLinux(lockPath, options);
  throw new EvalancheError(
    `exclusive lock is not available on ${process.platform}`,
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

function holdDarwin(lockPath: string): HeldLock {
  if (constants.O_NONBLOCK === undefined || constants.O_NOFOLLOW === undefined) {
    throw new EvalancheError('O_NONBLOCK is not available', EvalancheErrorCode.INVALID_CONFIG);
  }
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | DARWIN_O_EXLOCK | constants.O_NONBLOCK;
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

type LockPhase = 'starting' | 'held' | 'released' | 'failed';

async function holdLinux(lockPath: string, options: HoldLockOptions): Promise<HeldLock> {
  const helperFd = await openPinnedHelper(options.allowInsecureFilePermissions === true);
  const child = spawn(`/proc/self/fd/${helperFd}`, [lockPath], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return waitForHelper(child, helperFd, lockPath, options.onLockLost);
}

function waitForHelper(
  child: ChildProcess,
  helperFd: number,
  lockPath: string,
  onLockLost: (() => void) | undefined,
): Promise<HeldLock> {
  return new Promise((resolveHeld, reject) => {
    let phase: LockPhase = 'starting';
    let buf = '';
    let fd = helperFd;
    const closeHelperFd = () => {
      if (fd < 0) return;
      const current = fd;
      fd = -1;
      try {
        closeSync(current);
      } catch {
        // The descriptor is already closed.
      }
    };
    const fail = (message: string) => {
      if (phase !== 'starting') return;
      phase = 'failed';
      clearTimeout(timer);
      child.kill('SIGKILL');
      closeHelperFd();
      reject(new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG));
    };
    const timer = setTimeout(() => fail(`nonce lock helper timed out: ${lockPath}`), 3000);
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!buf.includes('ok') || phase !== 'starting') return;
      phase = 'held';
      clearTimeout(timer);
      resolveHeld({
        release() {
          if (phase !== 'held') return;
          phase = 'released';
          child.kill('SIGKILL');
        },
      });
    });
    child.on('error', (error) => {
      if (phase === 'starting') {
        fail(`nonce lock helper failed to start: ${error.message}`);
        return;
      }
      if (phase !== 'held') return;
      phase = 'failed';
      closeHelperFd();
      onLockLost?.();
    });
    child.on('exit', (code) => {
      closeHelperFd();
      if (phase === 'starting') {
        if (code === 2) fail(`nonce store is locked: ${lockPath}`);
        else fail(`nonce lock helper exited ${code ?? 'unknown'}: ${lockPath}`);
        return;
      }
      if (phase !== 'held') return;
      phase = 'failed';
      onLockLost?.();
    });
  });
}

/**
 * Candidate locations for the one shipped helper. The cwd is not searched.
 * A candidate that exists and fails the hash or ownership check is fatal.
 * ENOENT tries the next location.
 */
function helperCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, 'helpers', HELPER_NAME),
    join(here, '..', 'helpers', HELPER_NAME),
  ];
}

async function openPinnedHelper(insecure: boolean): Promise<number> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC;
  for (const candidate of helperCandidates()) {
    let fd: number;
    try {
      fd = openSync(candidate, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw new EvalancheError(
        `lock helper cannot be opened: ${candidate}`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) {
        throw new EvalancheError(
          `lock helper is not a regular file: ${candidate}`,
          EvalancheErrorCode.INVALID_CONFIG,
        );
      }
      if (!insecure) {
        await assertSecureParents(candidate);
        const mode = info.mode & 0o777;
        if (info.uid !== 0 || (mode & 0o022) !== 0) {
          throw new EvalancheError(
            `${candidate} must be owned by root and not writable by group or other`,
            EvalancheErrorCode.INVALID_CONFIG,
          );
        }
      }
      const digest = hashDescriptor(fd, info.size);
      if (digest !== LINUX_HELPER_SHA256) {
        throw new EvalancheError(
          `lock helper hash does not match the pinned digest: ${candidate}`,
          EvalancheErrorCode.INVALID_CONFIG,
        );
      }
      return fd;
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
      throw error;
    }
  }
  throw new EvalancheError(
    'pinned Linux lock helper is missing from the package',
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

/** Hash the open helper. The explicit position leaves the descriptor offset at 0. */
function hashDescriptor(fd: number, size: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (count === 0) break;
    hash.update(chunk.subarray(0, count));
    position += count;
  }
  if (position !== size) {
    throw new EvalancheError('lock helper read was truncated', EvalancheErrorCode.INVALID_CONFIG);
  }
  return hash.digest('hex');
}

function locked(lockPath: string): never {
  throw new EvalancheError(`nonce store is locked: ${lockPath}`, EvalancheErrorCode.INVALID_CONFIG);
}
