/**
 * The box start script must not trust a pidfile.
 * A stale socket is removed, a second start fails while a signer is live,
 * and stop refuses a pid that is not the signer.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    const durable = join(root, 'home', 'evalanche-signer');
    const prefix = join(root, 'opt', 'evalanche-signer');
    const ephemeral = join(root, 'var', 'evalanche-signer');
    const fakebin = join(root, 'fakebin');
    await mkdir(fakebin, { recursive: true });
    const tarball = join(root, 'evalanche-1.15.0.tgz');
    await writeFile(tarball, 'pinned-tarball\n');
    const npmLog = join(root, 'npm.log');
    const npm = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
prefix=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then prefix=$arg; fi
  prev=$arg
done
mkdir -p "$prefix/node_modules/evalanche/scripts" "$prefix/node_modules/.bin"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$prefix/node_modules/.bin/evalanche-signer"
chmod 755 "$prefix/node_modules/.bin/evalanche-signer"
printf '%s\\n' '#!/bin/sh' 'echo packaged' > "$prefix/node_modules/evalanche/scripts/grok-bot-signer.sh"
chmod 755 "$prefix/node_modules/evalanche/scripts/grok-bot-signer.sh"
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
      EVALANCHE_BOX_EPHEMERAL: ephemeral,
      EVALANCHE_BOX_CONFIG: join(durable, 'etc/config.json'),
      EVALANCHE_BOX_STATE: join(durable, 'state'),
      EVALANCHE_BOX_LOG_DIR: join(ephemeral, 'log'),
      EVALANCHE_BOX_SOCKET_DIR: join(ephemeral, 'run'),
      EVALANCHE_BOX_SOCKET: join(ephemeral, 'run/signer.sock'),
      EVALANCHE_BOX_PIDFILE: join(durable, 'state/signer.pid'),
      EVALANCHE_BOX_LOG: join(ephemeral, 'log/signer.log'),
      EVALANCHE_BOX_USER: drop?.name ?? userInfo().username,
      EVALANCHE_BOX_TOKEN_FILE: join(durable, 'etc/token'),
      EVALANCHE_BOX_VERIFIER_KEY: join(durable, 'etc/verifier.key'),
      EVALANCHE_BOX_VERIFIER_PUB: join(durable, 'etc/verifier.pub'),
      EVALANCHE_BOX_LOCK: join(durable, 'state/start.lock'),
    };
    const box = { root, durable, prefix, ephemeral, tarball, npmLog, env, drop };
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

  it('recreates the install and keeps the nonce file across a wiped ephemeral tree', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const first = provision(box, ['provision', box.tarball, digest]);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(statSync(join(box.durable, 'state')).mode & 0o777).toBe(0o700);
    expect(statSync(join(box.ephemeral, 'run')).mode & 0o777).toBe(0o750);
    expect(statSync(box.durable).mode & 0o777).toBe(0o755);
    const noncePath = join(box.durable, 'state/nonces.json');
    const nonce = '{"version":1,"keep":true}\n';
    await writeFile(noncePath, nonce);
    const configPath = join(box.durable, 'etc/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { nonceStorePath: string; marker?: string };
    expect(config.nonceStorePath).toBe(noncePath);
    config.marker = 'keep';
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    await rm(box.prefix, { recursive: true, force: true });
    await rm(box.ephemeral, { recursive: true, force: true });
    const second = provision(box, ['provision', box.tarball, digest]);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(readFileSync(noncePath, 'utf8')).toBe(nonce);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).marker).toBe('keep');
    expect(existsSync(join(box.prefix, 'node_modules/.bin/evalanche-signer'))).toBe(true);
    expect(existsSync(join(box.ephemeral, 'run'))).toBe(true);
    expect(existsSync(join(box.durable, 'bin/grok-bot-signer.sh'))).toBe(true);
    const log = readFileSync(box.npmLog, 'utf8');
    expect(log).toContain('--omit=dev');
    expect(log).toContain('--ignore-scripts');
    expect(log.trim().split('\n')).toHaveLength(2);
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
    await writeFile(join(box.durable, 'etc/config.json'), `${JSON.stringify({
      nonceStorePath: '/tmp/nonces.json',
      auditLogPath: join(box.durable, 'state/audit.jsonl'),
      verifierPublicKeyPath: join(box.durable, 'etc/verifier.pub'),
    })}\n`);
    const denied = provision(box, ['provision', box.tarball, digest]);
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/nonceStorePath/);
    expect(readFileSync(noncePath, 'utf8')).toBe('nonce-stays\n');
    expect(readFileSync(box.npmLog, 'utf8').trim().split('\n')).toHaveLength(calls);
  });
});

describe.skipIf(!linux || (process.getuid?.() ?? 0) !== 0)('grok-bot signer root overrides', () => {
  it('ignores EVALANCHE_BOX overrides when running as root', async () => {
    if (existsSync('/opt/evalanche-signer/node_modules/.bin/evalanche-signer')) return;
    const box = await layout();
    const result = spawnSync(script, ['start'], { env: box.env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).not.toBe(0);
    expect(existsSync(box.argv)).toBe(false);
    expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).toMatch(/missing user evalanche-signer|missing \/opt\/evalanche-signer/);
  });
});
