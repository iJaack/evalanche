import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe('npm-shrinkwrap', () => {
  const shrink = JSON.parse(readFileSync('npm-shrinkwrap.json', 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, { version?: string; integrity?: string }>;
  };

  it('matches package-lock.json byte for byte', () => {
    const lock = readFileSync('package-lock.json');
    const wrapped = readFileSync('npm-shrinkwrap.json');
    expect(createHash('sha256').update(wrapped).digest('hex')).toBe(createHash('sha256').update(lock).digest('hex'));
  });

  it('pins ethers, viem, and hyperliquid with integrity hashes', () => {
    expect(shrink.lockfileVersion).toBe(3);
    for (const name of ['node_modules/ethers', 'node_modules/viem', 'node_modules/@nktkas/hyperliquid']) {
      const pkg = shrink.packages[name];
      expect(pkg?.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg?.integrity, name).toMatch(/^sha512-/);
    }
  });
});
