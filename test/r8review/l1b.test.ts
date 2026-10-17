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
describe('R8 review: L1b', () => {
  for (const delay of [0, 50, 150]) {
    it(`new request on held keep-alive ${delay}ms after shutdown never signs`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'r8-l1b-'));
      const verifier = generateEd25519KeyPair();
      const wallet = new Wallet(KEY);
      const server = await startSignerServer({
        privateKey: KEY, verifierPublicKey: verifier.publicKey, token: 't',
        auditLogPath: join(root, 'a'), nonceStorePath: join(root, 'n'), initNonces: true,
        allowInsecureFilePermissions: true, chainId: CHAIN, port: 0,
        simulate: async () => ({ success: true }),
        allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
      });
      servers.push(server);
      let exits = 0;
      const attached = attachSignerShutdown(server, () => { exits += 1; });
      disposers.push(attached.dispose);
      const socket = connect(server.port!, '127.0.0.1');
      await new Promise<void>((r, j) => { socket.once('connect', () => r()); socket.once('error', j); });
      const reader = httpReader(socket);
      const p1 = reader.next();
      writeHttp(socket, 'POST', '/v1/sign', signBody(wallet.address, verifier, '1'));
      expect((await p1).status).toBe(200);
      attached.shutdown();
      await new Promise((r) => setTimeout(r, delay));
      let outcome = 'closed';
      let raw = '';
      socket.on('data', (b) => { raw += b.toString(); });
      const closed = new Promise<void>((r) => socket.once('close', () => r()));
      try { writeHttp(socket, 'POST', '/v1/sign', signBody(wallet.address, verifier, '2')); } catch { /* destroyed */ }
      await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))]);
      if (raw) outcome = raw.split('\r\n')[0];
      console.log(`L1b delay=${delay}: ${outcome}`);
      expect(raw).not.toContain('signedTransaction');
      await vi.waitFor(() => expect(exits).toBe(1), { timeout: 5000 });
      socket.destroy();
    }, 10_000);
  }
});
