/**
 * The box start script must not trust a pidfile.
 * A stale socket is removed, a second start fails while a signer is live,
 * and stop refuses a pid that is not the signer.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  return {
    root,
    bin,
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
      EVALANCHE_BOX_USER: userInfo().username,
      EVALANCHE_BOX_BIN: bin,
      EVALANCHE_BOX_TOKEN_FILE: join(root, 'token'),
      EVALANCHE_SIGNER_PRIVATE_KEY: 'test-key-do-not-print',
      FAKE_ARGV: join(root, 'argv.json'),
      FAKE_IGNORE_TERM: '',
    },
    socket: join(root, 'run/signer.sock'),
    pidfile: join(root, 'state/signer.pid'),
    argv: join(root, 'argv.json'),
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(script, args, { env, encoding: 'utf8', timeout: 20_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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
    const started = run(['start'], box.env);
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
    const health = run(['health'], box.env);
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toEqual({ ok: true, mode: 'dry-run' });
  }, 20_000);

  it('refuses a second start when the pidfile is missing', async () => {
    const box = await layout();
    const started = run(['start'], box.env);
    expect(started.status, started.stderr).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    await rm(box.pidfile);
    const again = run(['start'], box.env);
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
    const stopped = run(['stop'], box.env);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/unverified/);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(readFileSync(box.pidfile, 'utf8').trim()).toBe(String(pid));
  });

  it('exits non-zero when the signer ignores SIGTERM', async () => {
    const box = await layout();
    box.env.FAKE_IGNORE_TERM = '1';
    const started = run(['start'], box.env);
    expect(started.status, started.stderr).toBe(0);
    const pid = Number(readFileSync(box.pidfile, 'utf8').trim());
    const stopped = run(['stop'], box.env);
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/still alive/);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 20_000);

  it('starts live only with --live and creates nonces only from init', async () => {
    const box = await layout();
    const live = run(['start', '--live'], box.env);
    expect(live.status, live.stderr).toBe(0);
    const recorded = JSON.parse(readFileSync(box.argv, 'utf8')) as { args: string[] };
    expect(recorded.args).not.toContain('--dry-run');
    expect(recorded.args).not.toContain('--init-nonces');
    const health = run(['health'], box.env);
    expect(JSON.parse(health.stdout)).toEqual({ ok: true, mode: 'live' });
    const stopped = run(['stop'], box.env);
    expect(stopped.status, stopped.stderr).toBe(0);
    const init = run(['init'], box.env);
    expect(init.status, init.stderr).toBe(0);
    const again = JSON.parse(readFileSync(box.argv, 'utf8')) as { args: string[] };
    expect(again.args).toContain('--init-nonces');
    expect(again.args).toContain('--dry-run');
  }, 20_000);
});
