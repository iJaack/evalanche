/**
 * Open a path without following symlinks, fstat that same descriptor, and
 * read from it. Config, keystore, and verifier-key parents up to `/` must be
 * root-owned and not group- or world-writable. Signer state directories are
 * owned by the signer user.
 */

import { lstat, mkdir, open, constants, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
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
export async function readSecureFile(path: string, options?: SecurePathOptions): Promise<string> {
  const anchor = normalizeAnchor(options?.trustAnchor);
  if (!anchor) {
    await assertUnanchoredParents(path);
    const handle = await openNoFollow(path, OPEN_FILE);
    try {
      return await readRootOwnedFile(handle, path);
    } finally {
      await handle.close();
    }
  }
  const parent = await openAnchoredParent(path, anchor);
  try {
    const handle = await openChild(parent, basename(resolve(path)), path, OPEN_FILE);
    try {
      return await readRootOwnedFile(handle, path);
    } finally {
      await handle.close();
    }
  } finally {
    await parent.close();
  }
}

async function readRootOwnedFile(handle: FileHandle, path: string): Promise<string> {
  const info = await handle.stat();
  if (!info.isFile()) fail(`${path} is not a regular file`);
  assertRootOwned(info, path);
  return await handle.readFile({ encoding: 'utf8' });
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

/**
 * Optional root-owned directory where ownership checks stop.
 * Every component from `/` is still opened without following symlinks.
 * Parents above the anchor may be owned by another user. The anchor and
 * every directory from the anchor down to the file must be root-owned.
 */
export interface SecurePathOptions {
  trustAnchor?: string;
}

function normalizeAnchor(anchor: string | undefined): string | undefined {
  if (anchor === undefined) return undefined;
  const trimmed = anchor.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('/')) fail('trust anchor must be an absolute path');
  return resolve(trimmed);
}

/** Walk every parent of `path`, including `/`, and require a root-owned directory. */
export async function assertSecureParents(path: string, options?: SecurePathOptions): Promise<void> {
  const anchor = normalizeAnchor(options?.trustAnchor);
  if (!anchor) {
    await assertUnanchoredParents(path);
    return;
  }
  await assertAnchoredParents(path, anchor);
}

async function assertUnanchoredParents(path: string): Promise<void> {
  let current = dirname(resolve(path));
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    await assertSecureDir(current);
    if (current === '/') break;
    current = dirname(current);
  }
}

function underAnchor(dir: string, anchor: string): boolean {
  return dir === anchor || dir.startsWith(`${anchor}/`);
}

async function openChild(parent: FileHandle, name: string, logical: string, flags: number): Promise<FileHandle> {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    fail(`${logical} is not a single path component`);
  }
  const procPath = `/proc/self/fd/${parent.fd}/${name}`;
  try {
    return await open(procPath, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EPERM' || code === 'EACCES') {
      try {
        const info = await lstat(procPath);
        if (info.isSymbolicLink()) fail(`${logical} is a symlink; refusing to follow it`);
      } catch (statError) {
        if (statError instanceof EvalancheError) throw statError;
      }
    }
    if (code === 'ELOOP') fail(`${logical} is a symlink; refusing to follow it`);
    throw error;
  }
}

/**
 * Open the parent of `path` by walking from `/` without following symlinks.
 * Ownership is required only for the anchor and directories under it.
 * The caller closes the returned handle.
 */
async function openAnchoredParent(path: string, anchor: string): Promise<FileHandle> {
  if (process.platform !== 'linux') fail('trust anchor checks require a Linux directory walk');
  const resolved = resolve(path);
  if (!(resolved === anchor || resolved.startsWith(`${anchor}/`)) || dirname(resolved) === resolved) {
    fail(`${resolved} is outside the trust anchor ${anchor}`);
  }
  const parent = dirname(resolved);
  if (!underAnchor(parent, anchor)) {
    fail(`${resolved} is outside the trust anchor ${anchor}`);
  }
  const parts = parent === '/' ? [] : parent.split('/').filter((part) => part.length > 0);
  let handle = await openNoFollow('/', OPEN_DIR);
  try {
    let acc = '/';
    const rootInfo = await handle.stat();
    if (!rootInfo.isDirectory()) fail('/ is not a directory');
    if (underAnchor(acc, anchor)) assertRootOwned(rootInfo, acc);
    for (const part of parts) {
      const logical = acc === '/' ? `/${part}` : `${acc}/${part}`;
      const next = await openChild(handle, part, logical, OPEN_DIR);
      await handle.close();
      handle = next;
      acc = logical;
      const dirInfo = await handle.stat();
      if (!dirInfo.isDirectory()) fail(`${acc} is not a directory`);
      if (underAnchor(acc, anchor)) assertRootOwned(dirInfo, acc);
    }
    if (!underAnchor(acc, anchor)) fail(`${resolved} is outside the trust anchor ${anchor}`);
    const opened = handle;
    handle = undefined as unknown as FileHandle;
    return opened;
  } finally {
    if (handle) await handle.close();
  }
}

/** Stop ownership checks at `anchor`. A symlink anywhere in the path still fails. */
async function assertAnchoredParents(path: string, anchor: string): Promise<void> {
  const handle = await openAnchoredParent(path, anchor);
  await handle.close();
}

/**
 * Nonce, audit, budget, and lock directories. The directory itself is owned
 * by the signer user and mode 0700. Every parent up to `/` is root-owned,
 * not group- or world-writable, and not a symlink. A missing directory is
 * created only when those parents already pass.
 */
export async function assertSignerStateDirectory(dir: string, options?: SecurePathOptions): Promise<void> {
  const resolved = resolve(dir);
  const anchor = normalizeAnchor(options?.trustAnchor);
  if (!anchor) {
    await assertUnanchoredParents(resolved);
    let handle: FileHandle;
    try {
      handle = await openNoFollow(resolved, OPEN_DIR);
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(resolved, { mode: 0o700 });
      handle = await openNoFollow(resolved, OPEN_DIR);
    }
    await finishStateDir(handle, resolved);
    return;
  }
  const parent = await openAnchoredParent(resolved, anchor);
  try {
    const name = basename(resolved);
    let handle: FileHandle;
    try {
      handle = await openChild(parent, name, resolved, OPEN_DIR);
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
      handle = await openChild(parent, name, resolved, OPEN_DIR);
    }
    await finishStateDir(handle, resolved);
  } finally {
    await parent.close();
  }
}

async function finishStateDir(handle: FileHandle, resolved: string): Promise<void> {
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) fail(`${resolved} is not a directory`);
    assertSignerOwned(info, resolved, 0o700);
  } finally {
    await handle.close();
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
export async function assertStateFileIfExists(path: string, options?: SecurePathOptions): Promise<void> {
  const anchor = normalizeAnchor(options?.trustAnchor);
  let handle: FileHandle;
  let parent: FileHandle | undefined;
  try {
    if (anchor) {
      parent = await openAnchoredParent(path, anchor);
      handle = await openChild(parent, basename(resolve(path)), path, OPEN_FILE);
    } else {
      handle = await openNoFollow(path, OPEN_FILE);
    }
  } catch (error) {
    await parent?.close();
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
    await parent?.close();
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
