/**
 * SIGTERM and SIGINT close the signer and unlink its socket.
 * A config dryRun:true stays on; the CLI ORs it with the flag.
 */
import { readFileSync } from 'node:fs';
import { access, chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
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

  it('keeps cli.ts OR-ing config dryRun so a flag cannot clear it', () => {
    const cli = readFileSync(join(process.cwd(), 'src/signer/cli.ts'), 'utf8');
    expect(cli).toMatch(/dryRun:\s*args\.dryRun\s*\|\|\s*raw\.dryRun/);
    expect(cli).not.toMatch(/--live/);
  });
});
