/**
 * Open a path without following symlinks, fstat that same descriptor, and
 * read from it. Config, keystore, and verifier-key parents up to `/` must be
 * root-owned and not group- or world-writable. Signer state directories are
 * owned by the signer user.
 */

import { lstat, mkdir, open, constants, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

const OPEN_FILE = constants.O_RDONLY | constants.O_NOFOLLOW;
const OPEN_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_CONFIG);
}

function assertRootOwned(info: { uid: number; mode: number; isFile?: () => boolean }, label: string): void {
  const mode = info.mode & 0o777;
  if (info.uid !== 0 || (mode & 0o022) !== 0) {
    fail(`${label} must be owned by root and not writable by group or other`);
  }
}

async function openNoFollow(path: string, flags: number): Promise<FileHandle> {
  try {
    return await open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) fail(`${path} is a symlink; refusing to follow it`);
      } catch (statError) {
        if (statError instanceof EvalancheError) throw statError;
      }
    }
    if (code === 'ELOOP') fail(`${path} is a symlink; refusing to follow it`);
    throw error;
  }
}

/** fstat and read the bytes of one file through a single O_NOFOLLOW descriptor. */
export async function readSecureFile(path: string): Promise<string> {
  await assertSecureParents(path);
  const handle = await openNoFollow(path, OPEN_FILE);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(`${path} is not a regular file`);
    assertRootOwned(info, path);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function assertSecureDir(path: string): Promise<void> {
  const handle = await openNoFollow(path, OPEN_DIR);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) fail(`${path} is not a directory`);
    assertRootOwned(info, path);
  } finally {
    await handle.close();
  }
}

/** Walk every parent of `path`, including `/`, and require a root-owned directory. */
export async function assertSecureParents(path: string): Promise<void> {
  let current = dirname(resolve(path));
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    await assertSecureDir(current);
    if (current === '/') break;
    current = dirname(current);
  }
}

/**
 * Nonce, audit, budget, and lock directories. The directory itself is owned
 * by the signer user and mode 0700. Every parent up to `/` is root-owned,
 * not group- or world-writable, and not a symlink. A missing directory is
 * created only when those parents already pass.
 */
export async function assertSignerStateDirectory(dir: string): Promise<void> {
  const resolved = resolve(dir);
  await assertSecureParents(resolved);
  try {
    const handle = await openNoFollow(resolved, OPEN_DIR);
    try {
      const info = await handle.stat();
      if (!info.isDirectory()) fail(`${resolved} is not a directory`);
      assertSignerOwned(info, resolved, 0o700);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(resolved, { mode: 0o700 });
    await assertSignerStateDirectory(resolved);
  }
}

/** Socket directory: signer-owned, mode 0750, parents root-owned up to `/`. */
export async function assertSocketDirectory(dir: string): Promise<void> {
  const resolved = resolve(dir);
  await assertSecureParents(resolved);
  const handle = await openNoFollow(resolved, OPEN_DIR);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) fail(`${resolved} is not a directory`);
    assertSignerOwned(info, resolved, 0o750);
  } finally {
    await handle.close();
  }
}

/** An existing state file must be owned by the signer user and not group/other writable. */
export async function assertStateFileIfExists(path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(path, OPEN_FILE);
  } catch (error) {
    if (error instanceof EvalancheError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(`${path} is not a regular file`);
    const mode = info.mode & 0o777;
    const uid = signerUid();
    if (info.uid !== uid || (mode & 0o022) !== 0) {
      fail(`${path} must be owned by the signer user and not writable by group or other`);
    }
  } finally {
    await handle.close();
  }
}

function assertSignerOwned(info: { uid: number; mode: number }, label: string, modeExact: number): void {
  const mode = info.mode & 0o777;
  if (info.uid !== signerUid() || mode !== modeExact || (mode & 0o022) !== 0) {
    fail(`${label} must be owned by the signer user, mode 0${modeExact.toString(8)}, and not writable by group or other`);
  }
}

function signerUid(): number {
  if (typeof process.geteuid !== 'function') {
    fail('signer state checks require geteuid');
  }
  return process.geteuid();
}

/** Check an existing file in place. A missing file is left for the caller to create. */
export async function assertSecureFileIfExists(path: string): Promise<void> {
  try {
    await readSecureFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
