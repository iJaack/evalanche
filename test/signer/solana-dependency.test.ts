import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 dependency test: fetch forbidden'); }); vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => { try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });

// Read only within test callbacks: malformed/missing files must be assertion failures,
// not import-time/harness errors. Selection, installation and advisory checks are later work.
function readJson(name: string): any {
  let value: any; let error: unknown;
  try { value = JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')); } catch (caught) { error = caught; }
  expect(error, `${name} must be readable JSON`).toBeUndefined(); return value;
}
const RECOMMENDED = new Set(['@solana/kit', '@solana/codecs', '@solana/transactions', '@solana/transaction-messages', '@solana/addresses', '@solana/rpc']);
function runtimeEntries(): Array<[string, string]> {
  const entries = Object.entries(readJson('package.json').dependencies ?? {}).filter(([name]) => name.startsWith('@solana/')) as Array<[string, string]>;
  // An empty list cannot make pin/integrity assertions vacuously green.
  expect(entries.some(([name]) => RECOMMENDED.has(name)), 'declare at least one recommended Solana public-data runtime package').toBe(true);
  return entries;
}

describe('PR2 production public-data dependency contract (no dependency changes here)', () => {
  it('declares a recommended public-data package in dependencies', () => { runtimeEntries(); });
  it('pins every direct @solana runtime package to an exact stable version', () => {
    for (const [name, version] of runtimeEntries()) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it.each(['package-lock.json', 'npm-shrinkwrap.json'])('pins every selected runtime package with matching version and sha512 integrity in %s', (filename) => {
    const entries = runtimeEntries(); const lock = readJson(filename);
    for (const [name, version] of entries) {
      const entry = lock.packages?.[`node_modules/${name}`];
      expect(entry, name).toBeDefined(); expect(entry?.version, name).toBe(version);
      expect(entry?.integrity, name).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    }
  });
  it.each(['package-lock.json', 'npm-shrinkwrap.json'])('records exact runtime declarations at the root of %s', (filename) => {
    const entries = runtimeEntries(); const lock = readJson(filename);
    for (const [name, version] of entries) expect(lock.packages?.['']?.dependencies?.[name], name).toBe(version);
  });
  it('never relegates a declared @solana package to devDependencies only', () => {
    const pkg = readJson('package.json');
    for (const name of Object.keys(pkg.devDependencies ?? {}).filter((name) => name.startsWith('@solana/'))) {
      expect(Object.hasOwn(pkg.dependencies ?? {}, name), `${name} is runtime public-data code`).toBe(true);
    }
  });
  it('does not select @solana/web3.js as the production public-data adapter', () => {
    expect(Object.hasOwn(readJson('package.json').dependencies ?? {}, '@solana/web3.js')).toBe(false);
  });
  it.each(['package-lock.json', 'npm-shrinkwrap.json'])('contains no transitive compromised web3.js 1.95.6/1.95.7 anywhere in %s', (filename) => {
    const lock = readJson(filename);
    for (const [path, entry] of Object.entries(lock.packages ?? {}) as Array<[string, any]>) {
      if (/(?:^|\/)node_modules\/@solana\/web3\.js$/.test(path)) expect(['1.95.6', '1.95.7'], path).not.toContain(entry.version);
    }
    // Also cover legacy nested dependency sections if a lockfile carries one.
    function visit(dependencies: Record<string, any> = {}): void {
      for (const [name, entry] of Object.entries(dependencies)) {
        if (name === '@solana/web3.js') expect(['1.95.6', '1.95.7']).not.toContain(entry.version);
        visit(entry.dependencies);
      }
    }
    visit(lock.dependencies);
  });
});
