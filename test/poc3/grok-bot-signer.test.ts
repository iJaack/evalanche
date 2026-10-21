/**
 * The box start script must not trust a pidfile.
 * A stale socket is removed, a second start fails while a signer is live,
 * and stop refuses a pid that is not the signer.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('refuses a second start quickly while one signer is running', async () => {
    const box = await layout();
    const started = run(['start'], box);
    expect(started.status, started.stderr).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    const began = Date.now();
    const again = spawnSync(script, ['start'], {
      env: box.env,
      encoding: 'utf8',
      timeout: 5_000,
      ...creds(box),
    });
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(again.error).toBeUndefined();
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already running/);
    expect(signerPids(box.bin)).toEqual([pid]);
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target = '';
      try {
        target = readlinkSync(join(`/proc/${pid}/fd`, fd));
      } catch {
        continue;
      }
      expect(target).not.toContain('start.lock');
    }
  }, 20_000);

  it('closes the start lock fd before sudo', () => {
    const source = readFileSync(script, 'utf8');
    const start = source.indexOf('launch_signer() {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const fn = source.slice(start, end);
    const marker = join(tmpdir(), `gbs-fd9-${process.pid}`);
    const lock = `${marker}.lock`;
    const probe = `#!/bin/bash
set -eu
${fn}
sudo() {
  if [ -e /proc/self/fd/9 ]; then
    echo open > ${JSON.stringify(marker)}
  else
    echo closed > ${JSON.stringify(marker)}
  fi
  exit 0
}
NODE=/bin/true
BIN=/bin/true
CONFIG=/dev/null
SOCKET=/dev/null
LOG=/dev/null
SIGNER_USER=nobody
START_MARK=mark
SKIP_ROOT=0
exec 9>${JSON.stringify(lock)}
launch_signer ""
wait
`;
    const file = `${marker}.sh`;
    writeFileSync(file, probe, { mode: 0o755 });
    const result = spawnSync('bash', [file], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8').trim()).toBe('closed');
    rmSync(file, { force: true });
    rmSync(lock, { force: true });
    rmSync(marker, { force: true });
  });

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
    await mkdir(join(pack, 'dist', 'signer'), { recursive: true });
    await writeFile(join(pack, 'package.json'), '{"name":"evalanche","version":"1.15.0"}\n');
    await writeFile(join(pack, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n');
    await writeFile(join(pack, 'dist', 'signer', 'cli.mjs'), 'process.stdout.write("evalanche-signer 1.15.0\\n");\n');
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

  it('writes Avalanche slippage caps into the default config', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const ready = provision(box, ['provision', box.tarball, digest]);
    expect(ready.status, ready.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(box.durable, 'config.json'), 'utf8')) as {
      slippageCaps: { stableBps: number; topBps: number; otherBps: number; stables: string[]; top: string[] };
    };
    expect(config.slippageCaps.stableBps).toBe(50);
    expect(config.slippageCaps.topBps).toBe(200);
    expect(config.slippageCaps.otherBps).toBe(300);
    expect(config.slippageCaps.stables.map((item) => item.toLowerCase())).toEqual([
      '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
    ]);
    expect(config.slippageCaps.top.map((item) => item.toLowerCase())).toEqual([
      '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
      '0x152b9d0fdc40c096757f570a51e494bd4b943e50',
      '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
      '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be',
    ]);
  });

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
    expect(existsSync(join(box.prefix, 'dist/signer/cli.mjs'))).toBe(true);
    expect(existsSync(join(box.prefix, 'node.path'))).toBe(true);
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

  function give(box: Awaited<ReturnType<typeof provisionLayout>>, path: string) {
    if (!box.drop) return;
    const chowned = spawnSync('chown', ['-R', `${box.drop.uid}:${box.drop.gid}`, path]);
    if (chowned.status !== 0) throw new Error(chowned.stderr?.toString() || 'chown failed');
  }

  async function packVersion(dir: string, version: string, filename: string): Promise<string> {
    const packRoot = join(dir, `pack-${filename.replace(/[^A-Za-z0-9.]+/g, '-')}`);
    const pack = join(packRoot, 'package');
    await mkdir(join(pack, 'scripts'), { recursive: true });
    await mkdir(join(pack, 'dist', 'signer'), { recursive: true });
    await writeFile(join(pack, 'package.json'), `${JSON.stringify({ name: 'evalanche', version })}\n`);
    await writeFile(join(pack, 'npm-shrinkwrap.json'), '{"lockfileVersion":3}\n');
    await writeFile(join(pack, 'dist', 'signer', 'cli.mjs'), 'process.stdout.write("packed\\n");\n');
    await writeFile(join(pack, 'scripts/grok-bot-signer.sh'), '#!/bin/sh\necho packaged\n', { mode: 0o755 });
    const tarball = join(dir, filename);
    const packed = spawnSync('tar', ['-czf', tarball, '-C', packRoot, 'package']);
    if (packed.status !== 0) throw new Error(packed.stderr?.toString() || 'tar failed');
    return tarball;
  }

  it('names the pinned tarball from the staged package.json when no path is given', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const env = { ...box.env };
    delete env.EVALANCHE_BOX_TARBALL;
    const run = (args: string[]) => spawnSync(script, args, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    });
    const missing = run(['provision', '', digest]);
    expect(missing.status).not.toBe(0);
    expect(`${missing.stderr}`).toMatch(/installed tree is not used/);
    expect(`${missing.stderr}`).not.toMatch(/1\.17\.0-rc\.5/);
    expect(existsSync(box.npmLog)).toBe(false);

    await mkdir(box.durable, { recursive: true });
    const pinned = join(box.durable, 'evalanche-1.15.0.tgz');
    await writeFile(pinned, readFileSync(box.tarball));
    give(box, box.durable);
    const ready = run(['provision', '', digest]);
    expect(ready.status, ready.stderr).toBe(0);
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(join(box.durable, 'evalanche-1.17.0-rc.5.tgz'))).toBe(false);
    expect(existsSync(join(box.prefix, 'dist/signer/cli.mjs'))).toBe(true);
  });

  it('reads the staged version after /opt is wiped and ignores an installed package.json', async () => {
    const box = await provisionLayout();
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    await mkdir(join(box.prefix, 'bin'), { recursive: true });
    await writeFile(join(box.prefix, 'package.json'), '{"name":"evalanche","version":"9.9.9"}\n');
    const installed = join(box.prefix, 'bin', 'grok-bot-signer.sh');
    await copyFile(script, installed);
    await chmod(installed, 0o755);
    // The dropped user has to unlink PREFIX. That needs a writable parent.
    give(box, box.root);
    const fromOpt = spawnSync(installed, ['provision', box.tarball, digest], {
      env: box.env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    });
    expect(fromOpt.status, fromOpt.stderr).toBe(0);
    expect(existsSync(join(box.durable, 'evalanche-1.15.0.tgz'))).toBe(true);
    expect(existsSync(join(box.durable, 'evalanche-9.9.9.tgz'))).toBe(false);

    await rm(box.prefix, { recursive: true, force: true });
    await rm(join(box.durable, 'evalanche-1.15.0.tgz'), { force: true });
    const recovery = join(box.root, 'recovery');
    await mkdir(join(recovery, 'bin'), { recursive: true });
    await writeFile(join(recovery, 'package.json'), '{"name":"evalanche","version":"8.8.8"}\n');
    const recoveryScript = join(recovery, 'bin', 'grok-bot-signer.sh');
    await copyFile(script, recoveryScript);
    await chmod(recoveryScript, 0o755);
    give(box, recovery);
    const wiped = spawnSync(recoveryScript, ['provision', box.tarball, digest], {
      env: box.env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    });
    expect(wiped.status, wiped.stderr).toBe(0);
    expect(existsSync(join(box.prefix, 'dist/signer/cli.mjs'))).toBe(true);
    expect(readFileSync(join(box.prefix, 'package.json'), 'utf8')).toContain('"version":"1.15.0"');
    expect(existsSync(join(box.durable, 'evalanche-1.15.0.tgz'))).toBe(true);
    expect(existsSync(join(box.durable, 'evalanche-8.8.8.tgz'))).toBe(false);
    expect(existsSync(join(box.durable, 'evalanche-9.9.9.tgz'))).toBe(false);
  });

  it('refuses a bad or mismatched tarball version before npm', async () => {
    const box = await provisionLayout();
    const latest = await packVersion(box.root, 'latest', 'incoming.tgz');
    give(box, latest);
    const latestDigest = createHash('sha256').update(readFileSync(latest)).digest('hex');
    const bad = provision(box, ['provision', latest, latestDigest]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/not a release version/);
    expect(existsSync(box.npmLog)).toBe(false);

    const traversal = await packVersion(box.root, '../evil', 'incoming-evil.tgz');
    give(box, traversal);
    const traversalDigest = createHash('sha256').update(readFileSync(traversal)).digest('hex');
    const escaped = provision(box, ['provision', traversal, traversalDigest]);
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toMatch(/not a release version/);
    expect(existsSync(box.npmLog)).toBe(false);
    expect(existsSync(join(box.durable, 'evalanche-..'))).toBe(false);

    const mismatched = join(box.root, 'evalanche-9.9.9.tgz');
    await copyFile(box.tarball, mismatched);
    give(box, mismatched);
    const mismatchDigest = createHash('sha256').update(readFileSync(mismatched)).digest('hex');
    const mismatch = provision(box, ['provision', mismatched, mismatchDigest]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/tarball version 1\.15\.0 does not match evalanche-9\.9\.9\.tgz/);
    expect(existsSync(box.npmLog)).toBe(false);
    expect(existsSync(join(box.durable, 'evalanche-9.9.9.tgz'))).toBe(false);
    expect(existsSync(join(box.prefix, 'dist/signer/cli.mjs'))).toBe(false);
  });

  function recordedOwner(stub: string, path: string): { uid: string; gid: string; mode: string } {
    const text = readFileSync(join(stub, 'owners.tsv'), 'utf8');
    let found: { uid: string; gid: string; mode: string } | undefined;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const [name, uid, gid, mode] = line.split('\t');
      if (name === path) found = { uid: uid ?? '', gid: gid ?? '', mode: mode ?? '' };
    }
    if (!found) throw new Error(`no recorded owner for ${path}`);
    return found;
  }

  function expectOwner(stub: string, path: string, uid: string, gid: string, mode: string) {
    const recorded = recordedOwner(stub, path);
    expect(recorded, path).toEqual({ uid, gid, mode });
    expect(statSync(path).mode & 0o777, path).toBe(Number.parseInt(mode, 8));
  }

  it('keeps each state file owner on a second provision while the start lock exists', async () => {
    const box = await provisionLayout();
    const signer = '4242';
    const stub = join(box.root, 'ownership-stub');
    await mkdir(stub, { recursive: true });
    const env = {
      ...box.env,
      EVALANCHE_BOX_USER: signer,
      EVALANCHE_BOX_GROUP: signer,
      EVALANCHE_BOX_OWNERSHIP_STUB: stub,
    };
    const run = (args: string[]) => spawnSync(script, args, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    });
    const state = join(box.durable, 'state');
    await mkdir(join(state, 'extra'), { recursive: true });
    const nonce = `${JSON.stringify({
      version: 1,
      startedAt: 1,
      wallets: { '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266': { lastNonce: '42', used: ['42'] } },
    })}\n`;
    await writeFile(join(state, 'nonces.json'), nonce, { mode: 0o644 });
    await writeFile(join(state, 'nonces.json.bak'), nonce, { mode: 0o644 });
    await writeFile(join(state, 'audit.jsonl'), '{"decision":"allow"}\n', { mode: 0o644 });
    await writeFile(join(state, 'start.lock'), '', { mode: 0o644 });
    await writeFile(join(state, 'signer.pid'), '1\n', { mode: 0o644 });
    await writeFile(join(state, 'extra', 'keep.json'), '{}\n', { mode: 0o644 });
    await writeFile(join(box.durable, 'token'), 'token-keep-not-logged\n', { mode: 0o644 });
    give(box, box.durable);
    give(box, stub);
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const first = run(['provision', box.tarball, digest]);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    await rm(box.prefix, { recursive: true, force: true });
    await rm(box.ephemeral, { recursive: true, force: true });
    await rm(box.etc, { recursive: true, force: true });
    const second = run(['provision', box.tarball, digest]);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout + second.stderr).not.toContain('token-keep-not-logged');
    expectOwner(stub, join(state, 'start.lock'), '0', '0', '600');
    expectOwner(stub, join(state, 'signer.pid'), '0', '0', '600');
    expectOwner(stub, join(state, 'audit.jsonl'), signer, signer, '600');
    expectOwner(stub, join(state, 'nonces.json'), signer, signer, '600');
    expectOwner(stub, join(state, 'nonces.json.bak'), signer, signer, '600');
    expectOwner(stub, join(state, 'extra'), signer, signer, '700');
    expectOwner(stub, join(state, 'extra', 'keep.json'), signer, signer, '600');
    expectOwner(stub, state, signer, signer, '700');
    expect(readFileSync(join(state, 'nonces.json'), 'utf8')).toBe(nonce);
    expect(readFileSync(join(state, 'audit.jsonl'), 'utf8')).toBe('{"decision":"allow"}\n');
  });

  it('escrows and restores the token, nonce high-water mark, and backups', async () => {
    const box = await provisionLayout();
    const signer = '4242';
    const boxUser = '1000';
    const stub = join(box.root, 'ownership-stub');
    await mkdir(stub, { recursive: true });
    const env = {
      ...box.env,
      EVALANCHE_BOX_USER: signer,
      EVALANCHE_BOX_GROUP: signer,
      EVALANCHE_BOX_BOX_USER: boxUser,
      EVALANCHE_BOX_BOX_GROUP: boxUser,
      EVALANCHE_BOX_OWNERSHIP_STUB: stub,
    };
    const run = (args: string[]) => spawnSync(script, args, {
      env,
      encoding: 'utf8',
      timeout: 20_000,
      ...(box.drop ? { uid: box.drop.uid, gid: box.drop.gid } : {}),
    });
    const digest = createHash('sha256').update(readFileSync(box.tarball)).digest('hex');
    const state = join(box.durable, 'state');
    await mkdir(state, { recursive: true });
    const wallet = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const nonceBody = (last: string) => `${JSON.stringify({
      version: 1,
      startedAt: 1,
      wallets: { [wallet]: { lastNonce: last, used: [last] } },
      txNonces: { [wallet]: { '43114': last } },
    })}\n`;
    const token = 'token-keep-not-logged\n';
    const backup = 'nonce-backup-keep\n';
    await writeFile(join(box.durable, 'token'), token, { mode: 0o600 });
    await writeFile(join(state, 'nonces.json'), nonceBody('10'), { mode: 0o600 });
    await writeFile(join(state, 'nonces.json.bak'), backup, { mode: 0o600 });
    give(box, box.durable);
    give(box, stub);
    const ready = run(['provision', box.tarball, digest]);
    expect(ready.status, ready.stderr + ready.stdout).toBe(0);

    const escrow = join(box.root, 'escrow');
    const saved = run(['escrow', escrow]);
    expect(saved.status, saved.stderr + saved.stdout).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain('token-keep-not-logged');
    expect(saved.stdout + saved.stderr).not.toContain(backup.trim());
    expectOwner(stub, escrow, boxUser, boxUser, '700');
    expectOwner(stub, join(escrow, 'token'), boxUser, boxUser, '600');
    expectOwner(stub, join(escrow, 'nonces.json'), boxUser, boxUser, '600');
    expectOwner(stub, join(escrow, 'nonces.json.bak'), boxUser, boxUser, '600');
    expectOwner(stub, join(escrow, 'manifest.json'), boxUser, boxUser, '600');
    const manifest = JSON.parse(readFileSync(join(escrow, 'manifest.json'), 'utf8')) as {
      version: number;
      files: Array<{ name: string; sha256: string; mode: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.files.map((file) => file.name).sort()).toEqual(['nonces.json', 'nonces.json.bak', 'token']);
    for (const file of manifest.files) {
      expect(file.mode).toBe('600');
      expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(escrow, file.name))).digest('hex'));
    }

    await rm(state, { recursive: true, force: true });
    await rm(join(box.durable, 'token'), { force: true });
    const restored = run(['restore', escrow]);
    expect(restored.status, restored.stderr + restored.stdout).toBe(0);
    expect(restored.stdout + restored.stderr).not.toContain('token-keep-not-logged');
    expect(readFileSync(join(box.durable, 'token'), 'utf8')).toBe(token);
    expect(readFileSync(join(state, 'nonces.json'), 'utf8')).toBe(nonceBody('10'));
    expect(readFileSync(join(state, 'nonces.json.bak'), 'utf8')).toBe(backup);
    expectOwner(stub, box.durable, '0', '0', '755');
    expectOwner(stub, state, signer, signer, '700');
    expectOwner(stub, join(box.durable, 'log'), signer, signer, '700');
    expectOwner(stub, join(box.ephemeral, 'run'), signer, signer, '750');
    expectOwner(stub, join(box.durable, 'token'), '0', signer, '640');
    expectOwner(stub, join(state, 'nonces.json'), signer, signer, '600');
    expectOwner(stub, join(state, 'nonces.json.bak'), signer, signer, '600');

    const tampered = JSON.parse(readFileSync(join(escrow, 'manifest.json'), 'utf8')) as {
      files: Array<{ name: string; sha256: string }>;
    };
    const tokenEntry = tampered.files.find((file) => file.name === 'token');
    expect(tokenEntry).toBeDefined();
    tokenEntry!.sha256 = tokenEntry!.sha256.replace(/./, (char) => (char === 'a' ? 'b' : 'a'));
    await writeFile(join(escrow, 'manifest.json'), `${JSON.stringify(tampered)}\n`);
    give(box, escrow);
    await writeFile(join(state, 'nonces.json'), nonceBody('10'));
    const refused = run(['restore', escrow]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/hash mismatch/);
    expect(refused.stdout + refused.stderr).not.toContain('token-keep-not-logged');
    expect(readFileSync(join(state, 'nonces.json'), 'utf8')).toBe(nonceBody('10'));

    await writeFile(join(escrow, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    give(box, escrow);
    await writeFile(join(state, 'nonces.json'), nonceBody('11'));
    give(box, state);
    const rollback = run(['restore', escrow]);
    expect(rollback.status).not.toBe(0);
    expect(rollback.stderr).toMatch(/high-water mark/);
    expect(rollback.stdout + rollback.stderr).not.toMatch(/lastNonce|"11"/);
    expect(readFileSync(join(state, 'nonces.json'), 'utf8')).toBe(nonceBody('11'));

    await writeFile(join(state, 'nonces.json'), nonceBody('10'));
    give(box, state);
    const same = run(['restore', escrow]);
    expect(same.status, same.stderr + same.stdout).toBe(0);
    expect(readFileSync(join(state, 'nonces.json'), 'utf8')).toBe(nonceBody('10'));
    expect(same.stdout + same.stderr).not.toContain('token-keep-not-logged');
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
# /home, /opt, /var, and /etc are replaced below. Node on a GitHub runner
# lives under /opt/hostedtoolcache, so keep that directory reachable.
case "$nodebin" in
  /home/*|/opt/*|/var/*|/etc/*)
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
# 996 is the live box uid and gid. Take a free system id other than the old
# pin 960, and require provision to reuse a user that already has that uid.
want=""
candidate=996
while [ "$candidate" -ge 100 ]; do
  if [ "$candidate" != 960 ] \
    && ! getent group "$candidate" >/dev/null 2>&1 \
    && ! getent passwd "$candidate" >/dev/null 2>&1; then
    want=$candidate
    break
  fi
  candidate=$((candidate - 1))
done
test -n "$want"
groupadd --system --gid "$want" evalanche-signer
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
mkdir -p "$fake/pack/package/scripts" "$fake/pack/package/dist/signer"
printf '%s\\n' '{"name":"evalanche","version":"1.15.0"}' > "$fake/pack/package/package.json"
printf '%s\\n' 'process.stdout.write("evalanche-signer 1.15.0\\n");' > "$fake/pack/package/dist/signer/cli.mjs"
printf '%s\\n' '{"lockfileVersion":3}' > "$fake/pack/package/npm-shrinkwrap.json"
printf '%s\\n' '#!/bin/sh' 'echo packaged' > "$fake/pack/package/scripts/grok-bot-signer.sh"
chmod 755 "$fake/pack/package/scripts/grok-bot-signer.sh"
tar -czf "$tarball" -C "$fake/pack" package
digest=$(sha256sum "$tarball" | awk 'NR==1 { print $1 }')
"$SCRIPT" provision "$tarball" "$digest"
picked=$(id -u evalanche-signer)
test "$picked" -ge 100
test "$picked" -le 999
test "$(stat -c %u "$persist/state/nonces.json")" = "$picked"
userdel evalanche-signer
if ! getent group evalanche-signer >/dev/null 2>&1; then
  groupadd --system --gid "$want" evalanche-signer
fi
useradd --system --uid "$want" --gid "$want" --no-create-home --home-dir /var/lib/evalanche-signer --shell /bin/false evalanche-signer
"$SCRIPT" provision "$tarball" "$digest"
test ! -e "$persist/verifier.key"
test "$(stat -c %u "$persist/config.json")" = 0
test "$(stat -c %a "$persist/config.json")" = 644
test "$(id -u evalanche-signer)" = "$want"
test "$want" != 960
test "$(id -g evalanche-signer)" = "$want"
test "$(getent group evalanche-signer | cut -d: -f3)" = "$want"
test "$(stat -c %u "$persist/state/nonces.json")" = "$want"
test "$(stat -c %a "$persist/state/nonces.json")" = 600
test "$(stat -c %u "$persist/verifier.pub")" = 0
grep -q '"lastNonce":"42"' "$persist/state/nonces.json"
test "$(tr -d '\\n' < "$persist/verifier.pub")" = ed25519-pub-keep
mountpoint -q /var/lib/evalanche-signer/state
mountpoint -q /var/lib/evalanche-signer/log
test "$(stat -c %d:%i "$persist/state")" = "$(stat -c %d:%i /var/lib/evalanche-signer/state)"
state_opts=$(findmnt -no OPTIONS --target /var/lib/evalanche-signer/state)
log_opts=$(findmnt -no OPTIONS --target /var/lib/evalanche-signer/log)
for flag in nosuid nodev noexec; do
  printf '%s\\n' "$state_opts" | grep -q "$flag"
  printf '%s\\n' "$log_opts" | grep -q "$flag"
done
umount /var/lib/evalanche-signer/state
mount --bind "$persist/state" /var/lib/evalanche-signer/state
set +e
flag_out=$(EVALANCHE_SIGNER_PRIVATE_KEY=0xabc "$SCRIPT" start 2>&1)
flag_rc=$?
set -e
test "$flag_rc" -ne 0
printf '%s\\n' "$flag_out" | grep -q 'missing nosuid'
mount -o remount,bind,nosuid,nodev,noexec /var/lib/evalanche-signer/state
state_opts=$(findmnt -no OPTIONS --target /var/lib/evalanche-signer/state)
printf '%s\\n' "$state_opts" | grep -q noexec
userdel evalanche-signer
if ! getent group evalanche-signer >/dev/null 2>&1; then
  groupadd --system --gid "$want" evalanche-signer
fi
useradd --non-unique --uid 0 --gid "$want" --no-create-home --home-dir /var/lib/evalanche-signer --shell /bin/false evalanche-signer
set +e
zero_out=$("$SCRIPT" provision "$tarball" "$digest" 2>&1)
zero_rc=$?
set -e
test "$zero_rc" -ne 0
printf '%s\\n' "$zero_out" | grep -q 'system uid'
# userdel matches uid 0 to pid 1. Drop the name from the copied passwd instead.
sed -i '/^evalanche-signer:/d' /etc/passwd /etc/shadow
test "$(id -u root)" = 0
test "$(getent passwd evalanche-signer || true)" = ""
if ! getent group evalanche-signer >/dev/null 2>&1; then
  groupadd --system --gid "$want" evalanche-signer
fi
outside=10000
while getent passwd "$outside" >/dev/null 2>&1; do
  outside=$((outside + 1))
done
useradd --uid "$outside" --gid "$want" --no-create-home --home-dir /var/lib/evalanche-signer --shell /bin/false evalanche-signer
set +e
out_out=$("$SCRIPT" provision "$tarball" "$digest" 2>&1)
out_rc=$?
set -e
test "$out_rc" -ne 0
printf '%s\\n' "$out_out" | grep -q 'system uid'
userdel evalanche-signer
if ! getent group evalanche-signer >/dev/null 2>&1; then
  groupadd --system --gid "$want" evalanche-signer
fi
useradd --system --uid "$want" --gid "$want" --no-create-home --home-dir /var/lib/evalanche-signer --shell /bin/false evalanche-signer
saved_node=$(tr -d '\\n' < /opt/evalanche-signer/node.path)
bad_node=/opt/evalanche-signer/bad-node
cp "$saved_node" "$bad_node"
chown 1000:1000 "$bad_node"
chmod 755 "$bad_node"
printf '%s\\n' "$bad_node" > /opt/evalanche-signer/node.path
set +e
node_out=$(EVALANCHE_SIGNER_PRIVATE_KEY=0xabc "$SCRIPT" start 2>&1)
node_rc=$?
set -e
test "$node_rc" -ne 0
printf '%s\\n' "$node_out" | grep -q 'pinned node'
printf '%s\\n' "$saved_node" > /opt/evalanche-signer/node.path
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
    const signerHome = join(tmpdir(), `gbs-reset-src-${process.pid}`);
    const signerCopy = join(signerHome, 'scripts', 'grok-bot-signer.sh');
    await mkdir(join(signerHome, 'scripts'), { recursive: true });
    await writeFile(join(signerHome, 'package.json'), '{"name":"evalanche","version":"1.16.0"}\n');
    await copyFile(script, signerCopy);
    await chmod(signerCopy, 0o755);
    await writeFile(file, scriptBody.replaceAll('$SCRIPT', signerCopy).replaceAll('$NODE', process.execPath), { mode: 0o755 });
    const cmd = (process.getuid?.() ?? -1) === 0
      ? ['unshare', '--mount', 'bash', file]
      : ['sudo', '-n', 'unshare', '--mount', 'bash', file];
    const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: 180_000 });
    expect(`${result.stdout}\n${result.stderr}`, result.stderr).toContain('reset-ownership-ok');
    expect(result.status, result.stderr).toBe(0);
    await rm(file, { force: true });
    await rm(signerHome, { recursive: true, force: true });
  }, 180_000);
});

describe.skipIf(!DESTRUCTIVE || !canEnterMountNamespace())('grok-bot signer root tarball source', () => {
  it('ignores EVALANCHE_BOX_TARBALL and reads the version from the staged tarball', async () => {
    const scriptBody = `#!/bin/bash
set -eu
fake=$(mktemp -d)
cleanup() {
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
  /home/*|/opt/*|/var/*|/etc/*)
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
mkdir -p "$persist"
printf '%s\\n' 'token-keep' > "$persist/token"
printf '%s\\n' 'ed25519-pub-keep' > "$persist/verifier.pub"
good=$persist/evalanche-1.15.0.tgz
mkdir -p "$fake/pack/package/scripts" "$fake/pack/package/dist/signer"
printf '%s\\n' '{"name":"evalanche","version":"1.15.0"}' > "$fake/pack/package/package.json"
printf '%s\\n' 'process.stdout.write("evalanche-signer 1.15.0\\n");' > "$fake/pack/package/dist/signer/cli.mjs"
printf '%s\\n' '{"lockfileVersion":3}' > "$fake/pack/package/npm-shrinkwrap.json"
printf '%s\\n' '#!/bin/sh' 'echo packaged' > "$fake/pack/package/scripts/grok-bot-signer.sh"
chmod 755 "$fake/pack/package/scripts/grok-bot-signer.sh"
tar -czf "$good" -C "$fake/pack" package
digest=$(sha256sum "$good" | awk 'NR==1 { print $1 }')
mkdir -p "$fake/decoy-pack/package/scripts" "$fake/decoy-pack/package/dist/signer"
printf '%s\\n' '{"name":"evalanche","version":"9.9.9"}' > "$fake/decoy-pack/package/package.json"
printf '%s\\n' 'process.stdout.write("decoy\\n");' > "$fake/decoy-pack/package/dist/signer/cli.mjs"
printf '%s\\n' '{"lockfileVersion":3}' > "$fake/decoy-pack/package/npm-shrinkwrap.json"
printf '%s\\n' '#!/bin/sh' 'echo decoy' > "$fake/decoy-pack/package/scripts/grok-bot-signer.sh"
chmod 755 "$fake/decoy-pack/package/scripts/grok-bot-signer.sh"
decoy=$fake/decoy.tgz
tar -czf "$decoy" -C "$fake/decoy-pack" package
decoy_digest=$(sha256sum "$decoy" | awk 'NR==1 { print $1 }')
test ! -e /opt/evalanche-signer
export EVALANCHE_BOX_TARBALL="$fake/missing-env-tarball.tgz"
test ! -e "$EVALANCHE_BOX_TARBALL"
"$SCRIPT" provision "" "$digest"
test -f "$persist/evalanche-1.15.0.tgz"
test ! -e "$persist/evalanche-9.9.9.tgz"
test ! -e "$EVALANCHE_BOX_TARBALL"
grep -q '"version":"1.15.0"' /opt/evalanche-signer/package.json
test "$(wc -l < "$fake/npm.log")" -ge 1
before=$(wc -l < "$fake/npm.log")
rm -f "$persist/evalanche-1.15.0.tgz"
export EVALANCHE_BOX_TARBALL="$decoy"
set +e
ignored_out=$(EVALANCHE_BOX_TARBALL="$decoy" "$SCRIPT" provision "" "$decoy_digest" 2>&1)
ignored_rc=$?
set -e
test "$ignored_rc" -ne 0
printf '%s\\n' "$ignored_out" | grep -q 'installed tree is not used'
test ! -e "$persist/evalanche-9.9.9.tgz"
grep -q '"version":"1.15.0"' /opt/evalanche-signer/package.json
after=$(wc -l < "$fake/npm.log")
test "$before" = "$after"
printf '%s\\n' 'root-ignores-tarball-env'
`;
    const file = join(tmpdir(), `gbs-root-tarball-${process.pid}.sh`);
    const signerHome = join(tmpdir(), `gbs-root-tarball-src-${process.pid}`);
    const signerCopy = join(signerHome, 'scripts', 'grok-bot-signer.sh');
    await mkdir(join(signerHome, 'scripts'), { recursive: true });
    await writeFile(join(signerHome, 'package.json'), '{"name":"evalanche","version":"8.8.8"}\n');
    await copyFile(script, signerCopy);
    await chmod(signerCopy, 0o755);
    await writeFile(file, scriptBody.replaceAll('$SCRIPT', signerCopy).replaceAll('$NODE', process.execPath), { mode: 0o755 });
    const cmd = (process.getuid?.() ?? -1) === 0
      ? ['unshare', '--mount', 'bash', file]
      : ['sudo', '-n', 'unshare', '--mount', 'bash', file];
    const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: 120_000 });
    expect(`${result.stdout}\n${result.stderr}`, result.stderr).toContain('root-ignores-tarball-env');
    expect(result.status, result.stderr).toBe(0);
    await rm(file, { force: true });
    await rm(signerHome, { recursive: true, force: true });
  }, 120_000);
});

describe.skipIf(!linux || (process.getuid?.() ?? 0) !== 0)('grok-bot signer root overrides', () => {
  it('ignores EVALANCHE_BOX overrides when running as root', async () => {
    if (existsSync('/opt/evalanche-signer/dist/signer/cli.mjs')) return;
    const box = await layout();
    const result = spawnSync(script, ['start'], { env: box.env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).not.toBe(0);
    expect(existsSync(box.argv)).toBe(false);
    expect(`${result.stderr ?? ''}${result.stdout ?? ''}`).toMatch(/missing user evalanche-signer|missing \/opt\/evalanche-signer|\/var\/lib\/evalanche-signer\/state is not a bind mount/);
  });
});
