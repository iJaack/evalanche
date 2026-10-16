/**
 * Regression: the nonce-store lock must not run a compiler or an interpreter
 * found through PATH, and must not load a module that such a tool produced.
 *
 * Attack (f2b4707): src/signer/flock.ts runs `gcc` via PATH at startup and
 * require()s its output inside the signer process, then falls back to
 * `python3` via PATH. A fake gcc first in PATH therefore runs, and the module
 * it builds executes a constructor inside the process that holds the key.
 *
 * Expected after the fix (O_EXLOCK on darwin, prebuilt hash-pinned helper on
 * Linux): no marker file is written, whether or not the lock is acquired.
 * Everything lives in a per-test temp dir. The real /tmp/evalanche-flock is
 * never touched because TMPDIR points into the temp dir.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['PATH', 'TMPDIR', 'HOME', 'MONY_WALLET_PRIVATE_KEY', 'EVALANCHE_SIGNER_PRIVATE_KEY'] as const;

function findRealCompiler(): string | null {
  for (const candidate of ['/usr/bin/gcc', '/usr/bin/cc', '/usr/bin/clang']) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('sh', ['-c', 'command -v gcc || command -v cc'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

describe('flock helper: no compiler or interpreter from PATH', () => {
  let root = '';
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.MONY_WALLET_PRIVATE_KEY;
    delete process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
    // Base dir comes from the real tmpdir before TMPDIR is redirected below.
    root = await mkdtemp(join(tmpdir(), 'evalanche-flock-gcc-'));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it('never invokes gcc/python3 from PATH and never loads a module they built', async () => {
    const bin = join(root, 'bin');
    const fakeTmp = join(root, 'tmp');
    const fakeHome = join(root, 'home');
    const state = join(root, 'state');
    const markers = join(root, 'markers');
    await Promise.all([bin, fakeTmp, state, markers].map((dir) => mkdir(dir, { recursive: true })));

    // A header dir the vulnerable helper will accept, so the attack is reached
    // even on hosts without real Node headers. It contains no real headers.
    const fakeInclude = join(fakeHome, '.nvm', 'versions', 'node', 'v0.0.0-poc', 'include', 'node');
    await mkdir(fakeInclude, { recursive: true });
    await writeFile(join(fakeInclude, 'node_api.h'), '/* empty: test fixture */\n');

    const gccInvoked = join(markers, 'gcc-invoked');
    const moduleLoaded = join(markers, 'module-loaded');
    const pythonInvoked = join(markers, 'python3-invoked');
    const evilSource = join(root, 'evil.c');
    await writeFile(evilSource, [
      '#include <stdio.h>',
      `__attribute__((constructor)) static void poc(void) { FILE *f = fopen(${JSON.stringify(moduleLoaded)}, "w"); if (f) { fputs("constructor ran in signer process\\n", f); fclose(f); } }`,
      '',
    ].join('\n'));

    const realCompiler = findRealCompiler();
    // Fake gcc: record the call, then (if a real compiler exists) build a
    // shared object whose constructor drops a marker when it is loaded.
    await writeFile(join(bin, 'gcc'), [
      '#!/bin/sh',
      `echo "$@" > ${JSON.stringify(gccInvoked)}`,
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
      realCompiler ? `[ -n "$out" ] && exec ${JSON.stringify(realCompiler)} -shared -fPIC -o "$out" ${JSON.stringify(evilSource)}` : '',
      'exit 1',
      '',
    ].join('\n'));
    await writeFile(join(bin, 'python3'), [
      '#!/bin/sh',
      `echo "$@" > ${JSON.stringify(pythonInvoked)}`,
      'exit 1',
      '',
    ].join('\n'));
    await chmod(join(bin, 'gcc'), 0o755);
    await chmod(join(bin, 'python3'), 0o755);

    process.env.PATH = `${bin}:${saved.PATH ?? '/usr/bin:/bin'}`;
    process.env.TMPDIR = fakeTmp;
    process.env.HOME = fakeHome;

    vi.resetModules();
    const { NonceStore } = await import('../../src/signer/nonce-store');

    let store: { close(): Promise<void> } | null = null;
    let lockError: unknown = null;
    try {
      store = await NonceStore.open(join(state, 'nonces.json'), true);
    } catch (error) {
      lockError = error;
    } finally {
      if (store) await store.close();
    }

    const leftovers = existsSync(join(fakeTmp, 'evalanche-flock'))
      ? await readdir(join(fakeTmp, 'evalanche-flock'))
      : [];

    // Attack effects. Each must be absent after the fix.
    expect(existsSync(gccInvoked), 'gcc from PATH was invoked').toBe(false);
    expect(existsSync(moduleLoaded), 'a PATH-built module was loaded into the signer process').toBe(false);
    expect(existsSync(pythonInvoked), 'python3 from PATH was invoked').toBe(false);
    expect(leftovers, 'the lock wrote build artifacts under TMPDIR').toEqual([]);
    // Recorded for the report: the fixed helper should normally acquire the lock.
    void lockError;
  });
});
