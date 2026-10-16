import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CHAIN = 43114;
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  delete process.env.EVALANCHE_SIGNER_PRIVATE_KEY;
  while (servers.length) await servers.pop()?.close();
});

describe('signer env key', () => {
  it('reads EVALANCHE_SIGNER_PRIVATE_KEY and removes it from the environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'env-key-'));
    const verifier = generateEd25519KeyPair();
    process.env.EVALANCHE_SIGNER_PRIVATE_KEY = KEY;
    const server = await startSignerServer({
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    });
    servers.push(server);
    expect(process.env.EVALANCHE_SIGNER_PRIVATE_KEY).toBeUndefined();
    expect(server.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('does not echo a rejected env key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'env-key-bad-'));
    const verifier = generateEd25519KeyPair();
    const secret = 'not-a-key';
    process.env.EVALANCHE_SIGNER_PRIVATE_KEY = secret;
    await expect(startSignerServer({
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    })).rejects.toThrow(/EVALANCHE_SIGNER_PRIVATE_KEY is not a valid signer key/);
    expect(process.env.EVALANCHE_SIGNER_PRIVATE_KEY).toBeUndefined();
  });
});
