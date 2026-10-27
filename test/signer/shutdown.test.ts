/**
 * SIGTERM and SIGINT close the signer and unlink its socket.
 * A held keep-alive connection is halted before any further signature.
 * A config dryRun:true stays on; the CLI ORs it with the flag.
 */
import { readFileSync } from 'node:fs';
import { access, chmod, mkdtemp } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { computeApprovedTxHash, generateEd25519KeyPair, signVerifierApproval, startSignerServer } from '../../src/index';
import { attachSignerShutdown } from '../../src/signer/server';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHAIN = 43114;
const disposers: Array<() => void> = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (disposers.length) disposers.pop()?.();
  while (servers.length) await servers.pop()?.close();
});

describe('signer shutdown', () => {
  it('closes the server and unlinks the socket without exiting the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shut-'));
    await chmod(root, 0o750);
    const socketPath = join(root, 'signer.sock');
    const verifier = generateEd25519KeyPair();
    const server = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      socketPath,
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    });
    servers.push(server);
    const termBefore = process.listenerCount('SIGTERM');
    const intBefore = process.listenerCount('SIGINT');
    let exits = 0;
    let closes = 0;
    const wrapped = {
      close: async () => {
        closes += 1;
        await server.close();
      },
    };
    const attached = attachSignerShutdown(wrapped, () => {
      exits += 1;
    });
    disposers.push(attached.dispose);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1);
    expect(process.listenerCount('SIGINT')).toBe(intBefore + 1);
    attached.shutdown();
    attached.shutdown();
    await vi.waitFor(() => expect(exits).toBe(1));
    expect(closes).toBe(1);
    await expect(access(socketPath)).rejects.toThrow();
    attached.dispose();
    disposers.pop();
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
  });

  it('returns 503 on a held keep-alive connection after SIGTERM and does not sign', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shut-live-'));
    const verifier = generateEd25519KeyPair();
    const wallet = new Wallet(KEY);
    let calls = 0;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => {
        calls += 1;
        if (calls === 2) {
          entered?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { success: true };
      },
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    });
    servers.push(server);
    const port = server.port;
    if (!port) throw new Error('signer did not bind a port');
    let exits = 0;
    const attached = attachSignerShutdown(server, () => {
      exits += 1;
    });
    disposers.push(attached.dispose);
    const socket = connect(port, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      const reader = httpReader(socket);
      const firstPending = reader.next();
      writeHttp(socket, 'POST', '/v1/sign', signBody(wallet.address, verifier, '1'));
      const first = await firstPending;
      expect(first.status, first.body).toBe(200);
      expect(first.body).toContain('signedTransaction');

      const secondPending = reader.next();
      writeHttp(socket, 'POST', '/v1/sign', signBody(wallet.address, verifier, '2'));
      await inFlight;
      attached.shutdown();
      release?.();
      const second = await secondPending;
      expect(second.status, second.body).toBe(503);
      expect(second.body).not.toContain('signedTransaction');
      expect(second.body).not.toMatch(/"signature"/);
      expect(JSON.parse(second.body)).toMatchObject({ error: 'signer stopped' });
      await vi.waitFor(() => expect(exits).toBe(1));
      attached.dispose();
      disposers.pop();
    } finally {
      socket.destroy();
    }
  });

  it('keeps cli.ts OR-ing config dryRun so a flag cannot clear it', () => {
    const cli = readFileSync(join(process.cwd(), 'src/signer/cli.ts'), 'utf8');
    expect(cli).toMatch(/dryRun:\s*args\.dryRun\s*\|\|\s*raw\.dryRun/);
    expect(cli).not.toMatch(/--live/);
  });
});

function signBody(from: string, verifier: { publicKey: string; privateKey: string }, nonce: string): string {
  const now = Date.now();
  const tx = {
    to: PAYEE,
    value: '0',
    data: '0x',
    chainId: CHAIN,
    nonce: '0',
    gasLimit: '21000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1000000000',
    type: 0,
  };
  const intent = {
    version: '1' as const,
    intentId: `intent-${nonce}`,
    nonce,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: from,
    chainId: CHAIN,
    venue: 'spot',
    action: 'send',
    tokenIn: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6 },
    amountIn: '0',
    minAmountOut: '0',
    routeHash: computeApprovedTxHash(tx),
    tx,
  };
  const approval = signVerifierApproval({
    intent,
    verifierPrivateKey: verifier.privateKey,
    verifierPublicKey: verifier.publicKey,
    mode: 'live',
    signerAddress: from,
  });
  return JSON.stringify({
    requestId: `req-${nonce}`,
    kind: 'transaction',
    chainId: CHAIN,
    from,
    to: PAYEE,
    value: '0',
    data: '0x',
    gasLimit: '21000',
    gasPrice: '1000000000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'send a bounded transfer',
    structuredIntent: intent,
    approval,
  });
}

function writeHttp(socket: Socket, method: string, path: string, body: string): void {
  const payload = [
    `${method} ${path} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: keep-alive',
    'Authorization: Bearer t',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
  socket.write(payload);
}

function httpReader(socket: Socket): { next: () => Promise<{ status: number; body: string }> } {
  let buf = Buffer.alloc(0);
  const waiters: Array<(value: { status: number; body: string }) => void> = [];
  const failers: Array<(error: Error) => void> = [];
  const pump = () => {
    if (waiters.length === 0) return;
    const split = buf.indexOf('\r\n\r\n');
    if (split < 0) return;
    const header = buf.subarray(0, split).toString('utf8');
    const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(header)?.[1] ?? 0);
    const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    if (buf.length < split + 4 + len) return;
    const body = buf.subarray(split + 4, split + 4 + len).toString('utf8');
    buf = buf.subarray(split + 4 + len);
    failers.shift();
    waiters.shift()?.({ status, body });
    pump();
  };
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  socket.on('error', (error: Error) => {
    while (failers.length > 0) failers.shift()?.(error);
  });
  return {
    next() {
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        failers.push(reject);
        pump();
      });
    },
  };
}
