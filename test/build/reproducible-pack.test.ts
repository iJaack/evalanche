/**
 * Two clean build directories must pack to the same sha256.
 * Sourcemaps omit sourcesContent and use paths relative to the package,
 * so the absolute build directory is not part of dist/index.*.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function copyTree(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pack = spawn('tar', ['-C', ROOT, '--exclude', 'node_modules', '--exclude', 'dist', '--exclude', '.git', '--exclude', '.release-artifacts', '-cf', '-', '.']);
    const unpack = spawn('tar', ['-C', dir, '-xf', '-']);
    pack.stdout.pipe(unpack.stdin);
    let error = '';
    pack.stderr.on('data', (chunk) => { error += chunk.toString(); });
    unpack.stderr.on('data', (chunk) => { error += chunk.toString(); });
    unpack.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(error || `tar exited ${code}`));
    });
    pack.on('error', reject);
    unpack.on('error', reject);
  });
}

async function buildTree(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await copyTree(dir);
  execFileSync('cp', ['-al', join(ROOT, 'node_modules'), join(dir, 'node_modules')]);
  execFileSync('npx', ['tsup'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('reproducible pack', () => {
  it('packs identical bytes from two build directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'evalanche-pack-'));
    try {
      const left = await buildTree(parent, 'left');
      const right = await buildTree(parent, 'right');
      for (const file of ['dist/index.js', 'dist/index.mjs', 'dist/index.js.map', 'dist/index.mjs.map']) {
        const text = await readFile(join(left, file), 'utf8');
        expect(text, file).not.toContain(left);
        expect(text, file).not.toContain(ROOT);
      }
      const pack = (dir: string) => {
        const out = execFileSync('npm', ['pack', '--pack-destination', parent, '--json'], { cwd: dir, encoding: 'utf8' });
        const parsed = JSON.parse(out) as Array<{ filename: string }>;
        const filename = parsed[0]?.filename;
        if (!filename) throw new Error('npm pack did not name a tarball');
        return readFile(join(parent, filename));
      };
      const leftBytes = await pack(left);
      const version = JSON.parse(await readFile(join(left, 'package.json'), 'utf8')).version as string;
      execFileSync('mv', [join(parent, `evalanche-${version}.tgz`), join(parent, 'left.tgz')]);
      const rightBytes = await pack(right);
      expect(sha256(leftBytes)).toBe(sha256(rightBytes));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 180_000);
});
