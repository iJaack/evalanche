/**
 * Regression: the nonce-store lock must not write to, or load from, a shared
 * temp directory that another local user can pre-create.
 *
 * Attack (f2b4707): src/signer/flock.ts writes `$TMPDIR/evalanche-flock/flock.c`
 * with writeFileSync (follows symlinks) and builds/loads
 * `$TMPDIR/evalanche-flock/flock-<abi>.node`, after mkdirSync(recursive),
 * which accepts a directory someone else created. Planted symlinks therefore
 * redirect the signer's writes onto files of the attacker's choosing.
 *
 * Expected after the fix: the sentinels are byte-for-byte unchanged and the
 * planted directory contains only what the test put there. TMPDIR points into
 * a per-test temp dir, so the real /tmp/evalanche-flock is never touched.
 */
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['TMPDIR', 'MONY_WALLET_PRIVATE_KEY', 'EVALANCHE_SIGNER_PRIVATE_KEY'] as const;
const SOURCE_SENTINEL = 'sentinel: flock.c target must never be written\n';
const MODULE_SENTINEL = 'sentinel: .node target must never be written or loaded\n';

describe('flock helper: no writes or loads through a pre-created TMPDIR', () => {
  let root = '';
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.MONY_WALLET_PRIVATE_KEY;
    delete process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
    root = await mkdtemp(join(tmpdir(), 'evalanche-flock-symlink-'));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it('leaves symlink targets untouched and writes nothing into the planted dir', async () => {
    const fakeTmp = join(root, 'tmp');
    const planted = join(fakeTmp, 'evalanche-flock');
    const state = join(root, 'state');
    const sourceSentinel = join(root, 'sentinel-source.txt');
    const moduleSentinel = join(root, 'sentinel-module.txt');
    await mkdir(planted, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(sourceSentinel, SOURCE_SENTINEL);
    await writeFile(moduleSentinel, MODULE_SENTINEL);

    const moduleName = `flock-${process.versions.modules}.node`;
    await symlink(sourceSentinel, join(planted, 'flock.c'));
    await symlink(moduleSentinel, join(planted, moduleName));
    const plantedBefore = (await readdir(planted)).sort();

    process.env.TMPDIR = fakeTmp;

    vi.resetModules();
    const { NonceStore } = await import('../../src/signer/nonce-store');

    let store: { close(): Promise<void> } | null = null;
    try {
      store = await NonceStore.open(join(state, 'nonces.json'), true);
    } catch {
      // Lock success is not what this test asserts; the side effects are.
    } finally {
      if (store) await store.close();
    }

    expect(await readFile(sourceSentinel, 'utf8'), 'flock.c symlink target was overwritten').toBe(SOURCE_SENTINEL);
    expect(await readFile(moduleSentinel, 'utf8'), '.node symlink target was overwritten').toBe(MODULE_SENTINEL);
    expect((await readdir(planted)).sort(), 'new files appeared in the planted TMPDIR dir').toEqual(plantedBefore);
    for (const name of ['flock.c', moduleName]) {
      const info = await lstat(join(planted, name));
      expect(info.isSymbolicLink(), `${name} was replaced`).toBe(true);
    }
    expect(await readlink(join(planted, 'flock.c'))).toBe(sourceSentinel);
    expect(await readlink(join(planted, moduleName))).toBe(moduleSentinel);
  });
});
