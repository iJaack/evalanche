/**
 * The box start script must not trust a pidfile.
 * A stale socket is removed, a second start fails while a signer is live,
 * and stop refuses a pid that is not the signer.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { userInfo, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const linux = platform() === 'linux';
const script = join(process.cwd(), 'scripts/grok-bot-signer.sh');
const roots: string[] = [];
const extraPids: number[] = [];

function signerPids(bin: string): number[] {
  const pids: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${name}/cmdline`).toString();
    } catch {
      continue;
    }
    if (cmd.includes(bin)) pids.push(Number(name));
  }
  return pids;
}

function sessionId(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(after[3]);
}

function pidState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
  } catch {
    return undefined;
  }
}

function dropIdentity(): { uid: number; gid: number; name: string } | undefined {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return undefined;
  const users = readFileSync('/etc/passwd', 'utf8').split('\n').map((line) => {
    const [name, , uid, gid, , , shell] = line.split(':');
    return { name: name ?? '', uid: Number(uid), gid: Number(gid), shell: shell ?? '' };
  }).filter((user) => user.name.length > 0 && user.uid > 0);
  const chosen = users.find((user) => user.name === 'node')
    ?? users.find((user) => user.shell.length > 0 && !/nologin|false/.test(user.shell));
  if (!chosen) throw new Error('root tests need a non-root user such as node');
  return { uid: chosen.uid, gid: chosen.gid, name: chosen.name };
}

async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'gbs-'));
  roots.push(root);
  const bin = join(root, 'fake-signer.cjs');
  await mkdir(join(root, 'state'));
  await mkdir(join(root, 'log'));
  await mkdir(join(root, 'run'), { mode: 0o750 });
  await chmod(join(root, 'run'), 0o750);
  const fake = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify({
  args,
  token: process.env.EVALANCHE_SIGNER_TOKEN || '',
}));
const socket = args[args.indexOf('--socket') + 1];
const dry = args.includes('--dry-run');
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const body = JSON.stringify({ ok: true, mode: dry ? 'dry-run' : 'live' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
});
try { fs.unlinkSync(socket); } catch {}
server.listen(socket);
if (process.env.FAKE_IGNORE_TERM === '1') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
} else {
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
`;
  await writeFile(bin, fake, { mode: 0o755 });
  await chmod(bin, 0o755);
  await writeFile(join(root, 'config.json'), '{}\n');
  await writeFile(join(root, 'token'), 'box-token-value\n', { mode: 0o640 });
  const drop = dropIdentity();
  if (drop) {
    const chowned = spawnSync('chown', ['-R', `${drop.uid}:${drop.gid}`, root]);
    if (chowned.status !== 0) throw new Error(chowned.stderr?.toString() || 'chown failed');
  }
  return {
    root,
    bin,
    drop,
    env: {
      ...process.env,
      EVALANCHE_BOX_SKIP_ROOT: '1',
      EVALANCHE_BOX_PREFIX: root,
      EVALANCHE_BOX_CONFIG: join(root, 'config.json'),
      EVALANCHE_BOX_STATE: join(root, 'state'),
      EVALANCHE_BOX_LOG_DIR: join(root, 'log'),
      EVALANCHE_BOX_SOCKET_DIR: join(root, 'run'),
      EVALANCHE_BOX_SOCKET: join(root, 'run/signer.sock'),
      EVALANCHE_BOX_PIDFILE: join(root, 'state/signer.pid'),
      EVALANCHE_BOX_LOG: join(root, 'log/signer.log'),
      EVALANCHE_BOX_USER: drop?.name ?? userInfo().username,
      EVALANCHE_BOX_BIN: bin,
      EVALANCHE_BOX_TOKEN_FILE: join(root, 'token'),
      EVALANCHE_BOX_LOCK: join(root, 'state/start.lock'),
      EVALANCHE_SIGNER_PRIVATE_KEY: 'test-key-do-not-print',
      FAKE_ARGV: join(root, 'argv.json'),
      FAKE_IGNORE_TERM: '',
    },
    socket: join(root, 'run/signer.sock'),
    pidfile: join(root, 'state/signer.pid'),
    argv: join(root, 'argv.json'),
  };
}

type Box = Awaited<ReturnType<typeof layout>>;

function creds(box: Box): { uid?: number; gid?: number } {
  return box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {};
}

/** A setuid child is not dumpable, so root cannot open its environ. Read it as the signer uid. */
function readEnviron(pid: number, box: Box): string {
  const path = `/proc/${pid}/environ`;
  if (!box.drop) return readFileSync(path).toString('utf8');
  const result = spawnSync('cat', [path], { uid: box.drop.uid, gid: box.drop.gid });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `could not read ${path}`);
  return (result.stdout ?? Buffer.alloc(0)).toString('utf8');
}

function run(args: string[], box: Box) {
  const options: SpawnSyncOptions = { env: box.env, encoding: 'utf8', timeout: 20_000, ...creds(box) };
  const result = spawnSync(script, args, options);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function collect(child: ReturnType<typeof spawn>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function leaveStaleSocket(socketPath: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer();
    server.listen(process.argv[1]);
    setInterval(() => {}, 1000);
  `, socketPath], { stdio: 'ignore' });
  const pid = child.pid;
  if (!pid) throw new Error('stale socket helper did not start');
  const started = Date.now();
  while (!existsSync(socketPath)) {
    if (Date.now() - started > 5000) throw new Error('stale socket did not appear');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.kill(pid, 'SIGKILL');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const bin = join(root, 'fake-signer.cjs');
    for (const pid of signerPids(bin)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
  while (extraPids.length) {
    const pid = extraPids.pop();
    if (pid === undefined) break;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe.skipIf(!linux)('grok-bot signer start and stop', () => {
  it('replaces a stale socket left by a dead signer', async () => {
    const box = await layout();
    const dead = await leaveStaleSocket(box.socket);
    await writeFile(box.pidfile, `${dead}\n`);
    expect(existsSync(box.socket)).toBe(true);
    try { process.kill(dead, 0); expect.fail('dead signer still alive'); } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    const started = run(['start'], box);
    expect(started.status, started.stderr + started.stdout).toBe(0);
    expect(started.stdout).not.toContain('test-key-do-not-print');
    expect(started.stderr).not.toContain('test-key-do-not-print');
    expect(started.stdout).not.toContain('box-token-value');
    expect(started.stderr).not.toContain('box-token-value');
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    expect(signerPids(box.bin)).toEqual([pid]);
    expect(sessionId(pid)).toBe(pid);
    const recorded = JSON.parse(readFileSync(box.argv, 'utf8')) as { args: string[]; token: string };
    expect(recorded.args).toContain('--dry-run');
    expect(recorded.args).not.toContain('--init-nonces');
    expect(recorded.args).not.toContain('--live');
    expect(recorded.token).toBe('box-token-value');
    const health = run(['health'], box);
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual({ ok: true, mode: 'dry-run' });
  }, 20_000);

  it('refuses a second start when the pidfile is missing', async () => {
    const box = await layout();
    const started = run(['start'], box);
    expect(started.status, started.stderr).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    await rm(box.pidfile);
    const again = run(['start'], box);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already running/);
    expect(signerPids(box.bin)).toEqual([pid]);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 20_000);

  it('does not kill an unverified pid on stop', async () => {
    const sleep = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = sleep.pid;
    if (!pid) throw new Error('sleep did not start');
    extraPids.push(pid);
    const box = await layout();
    await writeFile(box.pidfile, `${pid}\n`);
    const stopped = run(['stop'], box);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/unverified/);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(readFileSync(box.pidfile, 'utf8').trim()).toBe(String(pid));
  });

  it('exits non-zero when the signer ignores SIGTERM', async () => {
    const box = await layout();
    box.env.FAKE_IGNORE_TERM = '1';
    const started = run(['start'], box);
    expect(started.status, started.stderr).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    const stopped = run(['stop'], box);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/still alive/);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 20_000);

  it('starts live only with --live and creates nonces only from init', async () => {
    const box = await layout();
    const live = run(['start', '--live'], box);
    expect(live.status, live.stderr).toBe(0);
    const recorded = JSON.parse(readFileSync(box.argv, 'utf8')) as { args: string[] };
    expect(recorded.args).not.toContain('--dry-run');
    expect(recorded.args).not.toContain('--init-nonces');
    const health = run(['health'], box);
    expect(JSON.parse(health.stdout)).toEqual({ ok: true, mode: 'live' });
    const stopped = run(['stop'], box);
    expect(stopped.status, stopped.stderr).toBe(0);
    const init = run(['init'], box);
    expect(init.status, init.stderr).toBe(0);
    const again = JSON.parse(readFileSync(box.argv, 'utf8')) as { args: string[] };
    expect(again.args).toContain('--init-nonces');
    expect(again.args).toContain('--dry-run');
  }, 20_000);

  it('stops a running signer when the pidfile is missing', async () => {
    const box = await layout();
    const started = run(['start'], box);
    expect(started.status, started.stderr + started.stdout).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    await rm(box.pidfile);
    const stopped = run(['stop'], box);
    expect(stopped.status, stopped.stderr + stopped.stdout).toBe(0);
    expect(stopped.stdout).toMatch(/signer stopped/);
    const state = pidState(pid);
    expect(state === undefined || state === 'Z').toBe(true);
  }, 20_000);

  it('serializes concurrent starts and records only its own pid', async () => {
    const box = await layout();
    const options: SpawnOptions = { env: box.env, timeout: 20_000, ...creds(box) };
    const first = spawn(script, ['start'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const second = spawn(script, ['start'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const [left, right] = await Promise.all([collect(first), collect(second)]);
    const ok = [left, right].filter((result) => result.status === 0);
    const denied = [left, right].filter((result) => result.status !== 0);
    expect(ok, `${left.stderr}\n${right.stderr}`).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.stderr).toMatch(/already running/);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    expect(signerPids(box.bin).filter((candidate) => pidState(candidate) !== 'Z')).toEqual([pid]);
    const environ = readEnviron(pid, box);
    expect(environ).toContain('EVALANCHE_SIGNER_START_MARK=');
  }, 20_000);
});

describe.skipIf(!linux)('grok-bot signer provision', () => {
  async function provisionLayout() {
    const root = await mkdtemp(join(tmpdir(), 'gbs-prov-'));
    roots.push(root);
    const durable = join(root, 'home', 'box', 'agent-data', 'evalanche-persist');
    const prefix = join(root, 'opt', 'evalanche-signer');
    const etc = join(root, 'etc', 'evalanche-signer');
    const ephemeral = join(root, 'var', 'evalanche-signer');
    const fakebin = join(root, 'fakebin');
    await mkdir(fakebin, { recursive: true });
    const tarball = join(root, 'evalanche-1.15.0.tgz');
    const pack = join(root, 'pack', 'package');
    await mkdir(join(pack, 'scripts'), { recursive: true });
    await writeFile(join(pack, 'package.json'), '{"name":"evalanche","version":"1.15.0"}\n');
    await writeFile(join(pack, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n');
    await writeFile(join(pack, 'scripts/grok-bot-signer.sh'), '#!/bin/sh\necho packaged\n', { mode: 0o755 });
    const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'pack'), 'package']);
    if (packed.status !== 0) throw new Error(packed.stderr?.toString() || 'tar failed');
    const npmLog = join(root, 'npm.log');
    const npm = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix=$arg; fi
  prev=$arg
done
mkdir -p "$prefix/node_modules/.bin"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$prefix/node_modules/.bin/evalanche-signer"
chmod 755 "$prefix/node_modules/.bin/evalanche-signer"
`;
    await writeFile(join(fakebin, 'npm'), npm, { mode: 0o755 });
    const drop = dropIdentity();
    if (drop) {
      const chowned = spawnSync('chown', ['-R', `${drop.uid}:${drop.gid}`, root]);
      if (chowned.status !== 0) throw new Error(chowned.stderr?.toString() || 'chown failed');
    }
    const env = {
      ...process.env,
      PATH: `${fakebin}:${process.env.PATH ?? ''}`,
      EVALANCHE_BOX_SKIP_ROOT: '1',
      EVALANCHE_BOX_DURABLE: durable,
      EVALANCHE_BOX_PREFIX: prefix,
      EVALANCHE_BOX_ETC: etc,
      EVALANCHE_BOX_EPHEMERAL: ephemeral,
      EVALANCHE_BOX_CONFIG: join(durable, 'config.json'),
      EVALANCHE_BOX_STATE: join(durable, 'state'),
      EVALANCHE_BOX_NONCE: join(durable, 'state/nonces.json'),
      EVALANCHE_BOX_AUDIT: join(durable, 'state/audit.jsonl'),
      EVALANCHE_BOX_TARBALL: join(durable, 'evalanche-1.15.0.tgz'),
      EVALANCHE_BOX_LOG_DIR: join(ephemeral, 'log'),
      EVALANCHE_BOX_SOCKET_DIR: join(ephemeral, 'run'),
      EVALANCHE_BOX_SOCKET: join(ephemeral, 'run/signer.sock'),
      EVALANCHE_BOX_PIDFILE: join(durable, 'state/signer.pid'),
      EVALANCHE_BOX_LOG: join(ephemeral, 'log/signer.log'),
      EVALANCHE_BOX_USER: drop?.name ?? userInfo().username,
      EVALANCHE_BOX_TOKEN_FILE: join(durable, 'token'),
      EVALANCHE_BOX_VERIFIER_KEY: join(durable, 'verifier.key'),
      EVALANCHE_BOX_VERIFIER_PUB: join(durable, 'verifier.pub'),
      EVALANCHE_BOX_LOCK: join(durable, 'state/start.lock'),
    };
    const box = { root, durable, prefix, etc, ephemeral, tarball, npmLog, env, drop };
    return box;
  }

  function provision(box: Awaited<ReturnType<typeof provisionLayout>>, args: string[]) {
    const options: SpawnSyncOptions = {
      env: box.env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    };
    const result = spawnSync(script, args, options);
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('reuses the nonce high-water mark, audit chain head, and verifier pubkey across reinstall', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const first = provision(box, ['provision', box.tarball, digest]);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(statSync(join(box.durable, 'state')).mode & 0o777).toBe(0o700);
    expect(statSync(join(box.ephemeral, 'run')).mode & 0o777).toBe(0o750);
    expect(statSync(box.durable).mode & 0o777).toBe(0o755);

    const wallet = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const noncePath = join(box.durable, 'state/nonces.json');
    const nonce = `${JSON.stringify({
      version: 1,
      startedAt: 1,
      wallets: { [wallet]: { lastNonce: '42', used: ['7', '42'] } },
    })}\n`;
    await writeFile(noncePath, nonce);
    const auditPath = join(box.durable, 'state/audit.jsonl');
    const firstRecord = JSON.stringify({ prevHash: 'a'.repeat(64), decision: 'allow' });
    const headRecord = JSON.stringify({ prevHash: createHash('sha256').update(firstRecord).digest('hex'), decision: 'dry_run' });
    const audit = `${firstRecord}\n${headRecord}\n`;
    const chainHead = createHash('sha256').update(headRecord).digest('hex');
    await writeFile(auditPath, audit);
    const pubkey = 'ed25519-pub-keep\n';
    await writeFile(join(box.durable, 'verifier.pub'), pubkey);
    await writeFile(join(box.durable, 'token'), 'token-keep\n');

    await rm(box.prefix, { recursive: true, force: true });
    await rm(box.ephemeral, { recursive: true, force: true });
    await rm(box.etc, { recursive: true, force: true });
    const second = provision(box, ['provision', box.tarball, digest]);
    expect(second.status, second.stderr + second.stdout).toBe(0);

    const reused = JSON.parse(readFileSync(noncePath, 'utf8')) as { wallets: Record<string, { lastNonce: string }> };
    expect(reused.wallets[wallet].lastNonce).toBe('42');
    expect(readFileSync(auditPath, 'utf8')).toBe(audit);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(createHash('sha256').update(lines[lines.length - 1]).digest('hex')).toBe(chainHead);
    expect(readFileSync(join(box.durable, 'verifier.pub'), 'utf8')).toBe(pubkey);
    expect(existsSync(join(box.durable, 'verifier.key'))).toBe(false);
    expect(readFileSync(join(box.etc, 'verifier.pub'), 'utf8')).toBe(pubkey);
    expect(existsSync(join(box.etc, 'verifier.key'))).toBe(false);
    expect(readFileSync(join(box.etc, 'token'), 'utf8')).toBe('token-keep\n');
    expect(existsSync(join(box.prefix, 'node_modules/.bin/evalanche-signer'))).toBe(true);
    expect(existsSync(join(box.ephemeral, 'run'))).toBe(true);
    const log = readFileSync(box.npmLog, 'utf8');
    expect(log).toContain('ci');
    expect(log).toContain('--omit=dev');
    expect(log).toContain('--ignore-scripts');
    expect(log).not.toContain(' install ');
    expect(log.trim().split('\n')).toHaveLength(2);
  });

  it('refuses a verifier private key on disk', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const first = provision(box, ['provision', box.tarball, digest]);
    expect(first.status, first.stderr).toBe(0);
    await writeFile(join(box.durable, 'verifier.key'), 'ed25519-key-keep\n');
    const calls = readFileSync(box.npmLog, 'utf8').trim().split('\n').length;
    const again = provision(box, ['provision', box.tarball, digest]);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/OPS_VERIFIER_ED25519/);
    expect(existsSync(join(box.etc, 'verifier.key'))).toBe(false);
    expect(readFileSync(box.npmLog, 'utf8').trim().split('\n')).toHaveLength(calls);
  });

  it('rejects a bad tarball digest and a nonce path outside the durable home', async () => {
    const box = await provisionLayout();
    const missing = provision(box, ['provision']);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/tarball/);
    expect(existsSync(box.npmLog)).toBe(false);

    const mismatch = provision(box, ['provision', box.tarball, 'ab'.repeat(32)]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/sha256/);
    expect(existsSync(box.npmLog)).toBe(false);

    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const ready = provision(box, ['provision', box.tarball, digest]);
    expect(ready.status, ready.stderr).toBe(0);
    const noncePath = join(box.durable, 'state/nonces.json');
    await writeFile(noncePath, 'nonce-stays\n');
    const calls = readFileSync(box.npmLog, 'utf8').trim().split('\n').length;
    await writeFile(join(box.durable, 'config.json'), `${JSON.stringify({
      nonceStorePath: '/tmp/nonces.json',
      auditLogPath: join(box.durable, 'state/audit.jsonl'),
      verifierPublicKeyPath: join(box.durable, 'verifier.pub'),
    })}\n`);
    const denied = provision(box, ['provision', box.tarball, digest]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/nonceStorePath/);
    expect(readFileSync(noncePath, 'utf8')).toBe('nonce-stays\n');
    expect(readFileSync(box.npmLog, 'utf8').trim().split('\n')).toHaveLength(calls);
  });
});

/** Opt-in. The default suite must not call sudo, unshare, or userdel. */
const DESTRUCTIVE = process.env.EVALANCHE_DESTRUCTIVE_TESTS === '1';

function canEnterMountNamespace(): boolean {
  if (!DESTRUCTIVE || !linux) return false;
  if ((process.getuid?.() ?? -1) === 0) return spawnSync('unshare', ['--mount', 'true']).status === 0;
  return spawnSync('sudo', ['-n', 'unshare', '--mount', 'true']).status === 0;
}

describe.skipIf(!DESTRUCTIVE || !canEnterMountNamespace())('grok-bot signer reset ownership', () => {
  it('chowns uid 1000 state back to root and refuses to start when it cannot', async () => {
    const scriptBody = `#!/bin/bash
set -eu
fake=$(mktemp -d)
cleanup() {
  chattr -i "$fake/home/box/agent-data/evalanche-persist/state/nonces.json" 2>/dev/null || true
  umount /var/lib/evalanche-signer/state 2>/dev/null || true
  umount /var/lib/evalanche-signer/log 2>/dev/null || true
  umount /var /home /opt /etc 2>/dev/null || true
  umount "$fake/node" 2>/dev/null || true
  rm -rf "$fake"
}
trap cleanup EXIT
mkdir -p "$fake/etc" "$fake/home" "$fake/opt" "$fake/var" "$fake/bin"
nodebin="$NODE"
nodedir=$(dirname "$(readlink -f "$nodebin")")
case "$nodebin" in
  /home/*)
    mkdir -p "$fake/node"
    mount --bind "$nodedir" "$fake/node"
    nodedir="$fake/node"
    ;;
esac
cp -a /etc/. "$fake/etc/"
mount --bind "$fake/etc" /etc
mount --bind "$fake/home" /home
mount --bind "$fake/opt" /opt
mount --bind "$fake/var" /var
export PATH="/usr/sbin:/usr/bin:/sbin:/bin:$fake/bin:$nodedir"
if id evalanche-signer >/dev/null 2>&1; then
  userdel evalanche-signer || true
fi
if getent group evalanche-signer >/dev/null 2>&1; then
  groupdel evalanche-signer || true
fi
groupadd --system --gid 996 evalanche-signer
cat > "$fake/bin/npm" << EOF
#!/bin/sh
printf '%s\\\\n' "\\$*" >> "$fake/npm.log"
prefix=""
prev=""
for arg in "\\$@"; do
  if [ "\\$prev" = "--prefix" ]; then prefix=\\$arg; fi
  prev=\\$arg
done
mkdir -p "\\$prefix/node_modules/.bin"
printf '%s\\\\n' '#!/bin/sh' 'exit 0' > "\\$prefix/node_modules/.bin/evalanche-signer"
chmod 755 "\\$prefix/node_modules/.bin/evalanche-signer"
EOF
chmod 755 "$fake/bin/npm"
persist=/home/box/agent-data/evalanche-persist
mkdir -p "$persist/state" "$persist/log" /home/box/agent-data
nonce='{"version":1,"startedAt":1,"wallets":{"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266":{"lastNonce":"42","used":["42"]}}}'
printf '%s\\n' "$nonce" > "$persist/state/nonces.json"
printf '%s\\n' '{"prevHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","decision":"allow"}' > "$persist/state/audit.jsonl"
printf '%s\\n' 'ed25519-pub-keep' > "$persist/verifier.pub"
printf '%s\\n' 'token-keep' > "$persist/token"
chown -R 1000:1000 /home/box
chmod 755 /home /home/box /home/box/agent-data
tarball=$fake/evalanche-1.15.0.tgz
mkdir -p "$fake/pack/package/scripts"
printf '%s\\n' '{"name":"evalanche","version":"1.15.0"}' > "$fake/pack/package/package.json"
printf '%s\\n' '{"lockfileVersion":3}' > "$fake/pack/package/npm-shrinkwrap.json"
printf '%s\\n' '#!/bin/sh' 'echo packaged' > "$fake/pack/package/scripts/grok-bot-signer.sh"
chmod 755 "$fake/pack/package/scripts/grok-bot-signer.sh"
tar -czf "$tarball" -C "$fake/pack" package
digest=$(sha256sum "$tarball" | awk 'NR==1 { print $1 }')
"$SCRIPT" provision "$tarball" "$digest"
test ! -e "$persist/verifier.key"
test "$(stat -c %u "$persist/config.json")" = 0
test "$(stat -c %a "$persist/config.json")" = 644
test "$(id -u evalanche-signer)" = 960
test "$(id -g evalanche-signer)" = 996
test "$(getent group evalanche-signer | cut -d: -f3)" = 996
test "$(stat -c %u "$persist/state/nonces.json")" = 960
test "$(stat -c %a "$persist/state/nonces.json")" = 600
test "$(stat -c %u "$persist/verifier.pub")" = 0
grep -q '"lastNonce":"42"' "$persist/state/nonces.json"
test "$(tr -d '\\n' < "$persist/verifier.pub")" = ed25519-pub-keep
mountpoint -q /var/lib/evalanche-signer/state
mountpoint -q /var/lib/evalanche-signer/log
test "$(stat -c %d:%i "$persist/state")" = "$(stat -c %d:%i /var/lib/evalanche-signer/state)"
test "$(stat -c %u /etc/evalanche-signer/verifier.pub)" = 0
test "$(tr -d '\\n' < /etc/evalanche-signer/verifier.pub)" = ed25519-pub-keep
grep -q '/var/lib/evalanche-signer/state/nonces.json' /etc/evalanche-signer/config.json
chown 1000:1000 "$persist/config.json" "$persist/state/nonces.json"
set +e
start_out=$(EVALANCHE_SIGNER_PRIVATE_KEY=0xabc "$SCRIPT" start 2>&1)
start_rc=$?
set -e
test "$start_rc" -ne 0
printf '%s\\n' "$start_out" | grep -q 'refusing untrusted'
chown 1000:1000 "$persist/state/nonces.json"
chattr +i "$persist/state/nonces.json"
before=$(wc -l < "$fake/npm.log")
set +e
again_out=$("$SCRIPT" provision "$tarball" "$digest" 2>&1)
again_rc=$?
set -e
chattr -i "$persist/state/nonces.json"
test "$again_rc" -ne 0
printf '%s\\n' "$again_out" | grep -q 'cannot take ownership'
test "$(stat -c %u "$persist/state/nonces.json")" = 1000
grep -q '"lastNonce":"42"' "$persist/state/nonces.json"
after=$(wc -l < "$fake/npm.log")
test "$before" = "$after"
printf '%s\\n' 'reset-ownership-ok'
`;
    const file = join(tmpdir(), `gbs-reset-${process.pid}.sh`);
    const signerCopy = join(tmpdir(), `grok-bot-signer-${process.pid}.sh`);
    await copyFile(script, signerCopy);
    await chmod(signerCopy, 0o755);
    await writeFile(file, scriptBody.replaceAll('$SCRIPT', signerCopy).replaceAll('$NODE', process.execPath), { mode: 0o755 });
    const cmd = (process.getuid?.() ?? -1) === 0
      ? ['unshare', '--mount', 'bash', file]
      : ['sudo', '-n', 'unshare', '--mount', 'bash', file];
    const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: 60_000 });
    expect(`${result.stdout}\n${result.stderr}`, result.stderr).toContain('reset-ownership-ok');
    expect(result.status, result.stderr).toBe(0);
    await rm(file, { force: true });
    await rm(signerCopy, { force: true });
  }, 60_000);
});

describe.skipIf(!linux || (process.getuid?.() ?? 0) !== 0)('grok-bot signer root overrides', () => {
  it('ignores EVALANCHE_BOX overrides when running as root', async () => {
    if (existsSync('/opt/evalanche-signer/node_modules/.bin/evalanche-signer')) return;
    const box = await layout();
    const result = spawnSync(script, ['start'], { env: box.env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).not.toBe(0);
    expect(existsSync(box.argv)).toBe(false);
    expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).toMatch(/missing user evalanche-signer|missing \/opt\/evalanche-signer|\/var\/lib\/evalanche-signer\/state is not a bind mount/);
  });
});
