/**
 * Open a path without following symlinks, fstat that same descriptor, and
 * read from it. Every parent directory up to / must be root-owned and not
 * group- or world-writable.
 */

import { open, constants, type FileHandle } from 'node:fs/promises';
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
    if (code === 'ELOOP') fail(`${path} is a symlink; refusing to follow it`);
    throw error;
  }
}

/** fstat and read the bytes of one file through a single O_NOFOLLOW descriptor. */
export async function readSecureFile(path: string): Promise<string> {
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

/** Check an existing file in place. A missing file is left for the caller to create. */
export async function assertSecureFileIfExists(path: string): Promise<void> {
  try {
    await readSecureFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
