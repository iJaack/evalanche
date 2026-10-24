#!/usr/bin/env node
// Install the packed tarball with real npm ci and run dist/signer/cli.mjs.
// npm ci does not link the package's own bin into node_modules/.bin.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, parseArgs, readJson } from './release-helpers.mjs';

const run = promisify(execFile);

export async function checkSignerBin({ rootDir = DEFAULT_ROOT, packJsonFile } = {}) {
  const packPath = path.resolve(rootDir, packJsonFile);
  const [pack] = await readJson(packPath);
  const archive = path.join(path.dirname(packPath), pack.filename);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'evalanche-signer-bin-'));
  const prefix = path.join(temp, 'opt', 'evalanche-signer');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    await fs.mkdir(prefix, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', prefix, '--strip-components=1'], { timeout: 60_000 });
    await run(npm, ['ci', '--prefix', prefix, '--omit=dev', '--ignore-scripts'], {
      timeout: 180_000,
      maxBuffer: 10_000_000,
    });
    const linked = path.join(prefix, 'node_modules', '.bin', 'evalanche-signer');
    const bin = path.join(prefix, 'dist', 'signer', 'cli.mjs');
    await fs.access(bin);
    let linkedExists = true;
    try {
      await fs.lstat(linked);
    } catch (error) {
      if (error && error.code === 'ENOENT') linkedExists = false;
      else throw error;
    }
    if (linkedExists) {
      throw new Error(`${linked} exists; npm ci must not be required to link the package bin`);
    }
    const version = await run(process.execPath, [bin, '--version'], { timeout: 30_000 });
    const pkg = JSON.parse(await fs.readFile(path.join(prefix, 'package.json'), 'utf8'));
    const printed = version.stdout.trim();
    const expected = `evalanche-signer ${pkg.version}`;
    if (printed !== expected) {
      throw new Error(`expected ${expected}, got ${printed || version.stderr}`);
    }
    const script = await fs.readFile(path.join(rootDir, 'scripts', 'grok-bot-signer.sh'), 'utf8');
    if (!script.includes('BIN=$PREFIX/dist/signer/cli.mjs')) {
      throw new Error('grok-bot-signer.sh does not point BIN at dist/signer/cli.mjs');
    }
    process.stdout.write(`signer bin ${bin} ${printed}\n`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  if (!args['pack-json']) {
    process.stderr.write('usage: check-signer-bin.mjs --pack-json <npm-pack.json>\n');
    process.exit(2);
  }
  checkSignerBin({ packJsonFile: args['pack-json'] }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
