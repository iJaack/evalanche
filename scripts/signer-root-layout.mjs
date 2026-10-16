#!/usr/bin/env node
/**
 * Production-layout integration test. Run as root after `npm run build`.
 *
 * /opt/evalanche-signer-layout holds the built package (root, not group-writable).
 * /etc/evalanche-signer holds config, keystore, and verifier pubkey (root, 0644).
 * /var/lib/evalanche-signer is mode 0700 and owned by the evalanche-signer user.
 * The signer process is that user, not root. A second start with mode 0777 must fail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = '/opt/evalanche-signer-layout';
const configDir = '/etc/evalanche-signer';
const stateDir = '/var/lib/evalanche-signer';
const user = 'evalanche-signer';
const password = 'root-layout-test-password';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  console.error('signer-root-layout must run as root');
  process.exit(1);
}
if (!existsSync(join(root, 'dist/index.js')) || !existsSync(join(root, 'dist/helpers/flock-linux-x64'))) {
  console.error('dist is missing. Run npm run build first.');
  process.exit(1);
}

const id = spawnSync('id', ['-u', user], { encoding: 'utf8' });
if (id.status !== 0) {
  const added = spawnSync('useradd', ['--system', '--user-group', '--no-create-home', '--shell', '/bin/false', user], { encoding: 'utf8' });
  if (added.status !== 0) {
    console.error(added.stderr || 'useradd failed');
    process.exit(1);
  }
}
const uid = Number(spawnSync('id', ['-u', user], { encoding: 'utf8' }).stdout.trim());
const gid = Number(spawnSync('id', ['-g', user], { encoding: 'utf8' }).stdout.trim());
if (!uid || uid === 0) {
  console.error('dedicated signer user is missing or is root');
  process.exit(1);
}

await rm(prefix, { recursive: true, force: true });
await rm(configDir, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
await mkdir(prefix, { recursive: true, mode: 0o755 });
await cp(join(root, 'dist'), join(prefix, 'dist'), { recursive: true });
await mkdir(configDir, { recursive: true, mode: 0o755 });
await mkdir(stateDir, { recursive: true, mode: 0o700 });

const require = createRequire(join(root, 'dist/index.js'));
const { Wallet } = require('ethers');
const { generateEd25519KeyPair } = require(join(root, 'dist/index.js'));
const verifier = generateEd25519KeyPair();
const keystore = await new Wallet(KEY).encrypt(password);
await writeFile(join(configDir, 'config.json'), '{}\n', { mode: 0o644 });
await writeFile(join(configDir, 'keystore.json'), keystore, { mode: 0o644 });
await writeFile(join(configDir, 'verifier.pub'), `${verifier.publicKey}\n`, { mode: 0o644 });
spawnSync('chmod', ['-R', 'a+rX,go-w', join(prefix, 'dist')], { stdio: 'inherit' });
spawnSync('chmod', ['-R', 'a+rX,go-w', configDir], { stdio: 'inherit' });
await chmod(prefix, 0o755);
await chmod(join(prefix, 'dist/helpers/flock-linux-x64'), 0o755);
spawnSync('chown', ['-R', 'root:root', join(prefix, 'dist')], { stdio: 'inherit' });
spawnSync('chown', ['root:root', prefix], { stdio: 'inherit' });
spawnSync('chown', ['-R', 'root:root', configDir], { stdio: 'inherit' });
spawnSync('chown', ['-R', `${user}:${user}`, stateDir], { stdio: 'inherit' });
await chmod(stateDir, 0o700);
await symlink(join(root, 'node_modules'), join(prefix, 'node_modules'));

const sign = await runChild('sign');
if (sign.code !== 0 || !sign.stdout.includes('SIGNED')) {
  console.error(sign.stdout);
  console.error(sign.stderr);
  console.error(`production layout sign failed (${sign.code})`);
  process.exit(1);
}

await chmod(stateDir, 0o777);
const rejected = await runChild('bad-mode');
if (rejected.code === 0 || !rejected.stderr.includes('0700')) {
  console.error(rejected.stdout);
  console.error(rejected.stderr);
  console.error('mode 0777 state directory was accepted');
  process.exit(1);
}

console.log('root layout: signed as the dedicated user, and mode 0777 was rejected');

function runChild(mode) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/signer-root-child.mjs'), mode], {
      uid,
      gid,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: stateDir,
        EVALANCHE_LAYOUT_PREFIX: prefix,
        EVALANCHE_LAYOUT_CONFIG: configDir,
        EVALANCHE_LAYOUT_STATE: stateDir,
        EVALANCHE_SIGNER_KEYSTORE_PASSWORD: password,
        EVALANCHE_LAYOUT_VERIFIER_SECRET: verifier.privateKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
