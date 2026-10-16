/**
 * Exclusive non-blocking flock(2) held on a descriptor in this process.
 * The kernel drops the lock when the process dies, so a stale PID file is
 * not used. The helper is compiled once per Node ABI from the system headers.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, constants, existsSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

const SOURCE = `
#include <node_api.h>
#include <sys/file.h>
#include <errno.h>

static napi_value FlockEx(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  napi_get_value_int32(env, argv[0], &fd);
  int rc = flock(fd, LOCK_EX | LOCK_NB);
  napi_value out;
  napi_get_boolean(env, rc == 0, &out);
  return out;
}

static napi_value FlockUn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  napi_get_value_int32(env, argv[0], &fd);
  flock(fd, LOCK_UN);
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

NAPI_MODULE_INIT() {
  napi_value ex;
  napi_value un;
  napi_create_function(env, "lock", NAPI_AUTO_LENGTH, FlockEx, NULL, &ex);
  napi_create_function(env, "unlock", NAPI_AUTO_LENGTH, FlockUn, NULL, &un);
  napi_set_named_property(env, exports, "lock", ex);
  napi_set_named_property(env, exports, "unlock", un);
  return exports;
}
`;

interface FlockAddon {
  lock(fd: number): boolean;
  unlock(fd: number): void;
}

let addon: FlockAddon | null = null;

function nodeInclude(): string {
  const candidates = [
    join(dirname(process.execPath), '..', 'include', 'node'),
    '/usr/include/node',
    '/usr/local/include/node',
  ];
  const nvm = join(process.env.HOME ?? '', '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    for (const version of readdirSync(nvm)) {
      candidates.push(join(nvm, version, 'include', 'node'));
    }
  }
  const found = candidates.find((dir) => existsSync(join(dir, 'node_api.h')));
  if (!found) {
    throw new Error(`node_api.h was not found next to ${process.execPath}`);
  }
  return found;
}

function loadAddon(): FlockAddon {
  if (addon) return addon;
  const outDir = join(tmpdir(), 'evalanche-flock');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `flock-${process.versions.modules}.node`);
  const source = join(outDir, 'flock.c');
  try {
    writeFileSync(source, SOURCE);
    execFileSync('gcc', [
      '-shared',
      '-fPIC',
      `-I${nodeInclude()}`,
      '-o',
      out,
      source,
      '-Wl,--unresolved-symbols=ignore-all',
    ], { stdio: 'pipe' });
    const require = createRequire(join(process.cwd(), 'package.json'));
    addon = require(out) as FlockAddon;
    return addon;
  } catch (error) {
    throw new EvalancheError(
      `OS file lock (flock) is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      EvalancheErrorCode.INVALID_CONFIG,
    );
  }
}

export function flockExclusive(fd: number): boolean {
  return loadAddon().lock(fd);
}

export function flockUnlock(fd: number): void {
  loadAddon().unlock(fd);
}

export interface HeldLock {
  release(): void;
}

const PYTHON_LOCK = `
import ctypes, fcntl, os, signal, sys
libc = ctypes.CDLL(None)
libc.prctl(1, 9)
if os.getppid() == 1:
    sys.exit(1)
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(2)
sys.stdout.write('ok\\n')
sys.stdout.flush()
signal.pause()
`;

function lockedError(): never {
  throw new EvalancheError(
    'Nonce store is locked by another signer. Refusing to run a second signer.',
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

function holdWithAddon(lockPath: string): HeldLock {
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
  let locked = false;
  try {
    locked = flockExclusive(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!locked) {
    closeSync(fd);
    lockedError();
  }
  return {
    release() {
      try {
        flockUnlock(fd);
      } catch {
        // Closing the descriptor drops the lock as well.
      }
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };
}

function holdWithPython(lockPath: string): HeldLock {
  const child = spawn('python3', ['-c', PYTHON_LOCK, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const buf = Buffer.alloc(16);
  let text = '';
  try {
    if (!child.stdout) throw new Error('python lock has no stdout');
    const n = readSync((child.stdout as unknown as { fd: number }).fd, buf, 0, buf.length, null);
    text = buf.subarray(0, Math.max(n, 0)).toString('utf8');
  } catch {
    text = '';
  }
  if (text.startsWith('ok')) {
    return {
      release() {
        child.kill('SIGKILL');
      },
    };
  }
  const code = child.exitCode;
  child.kill('SIGKILL');
  if (code === 2) lockedError();
  throw new EvalancheError(
    'OS file lock (flock) is unavailable',
    EvalancheErrorCode.INVALID_CONFIG,
  );
}

/** Hold an exclusive flock until release. Uses an in-process helper, then Python. */
export function holdExclusiveLock(lockPath: string): HeldLock {
  try {
    return holdWithAddon(lockPath);
  } catch (error) {
    if (error instanceof EvalancheError && /locked by another signer/.test(error.message)) throw error;
    return holdWithPython(lockPath);
  }
}
