/**
 * After the Linux lock helper has said ok, its death must stop this process.
 * A second signer may then take the same nonce store. The first one must not
 * keep signing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { computeApprovedTxHash, generateEd25519KeyPair, signVerifierApproval, startSignerServer } from '../../src/index';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const W = new Wallet(KEY).address;
const CHAIN = 43114;
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function pidsForLock(lockPath: string): number[] {
  let names: string[] = [];
  try {
    names = readFileSync('/proc/self/task/self/children', 'utf8').trim().split(/\s+/).filter(Boolean);
  } catch {
    names = [];
  }
  if (names.length === 0) names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  const found: number[] = [];
  for (const pid of names) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`).toString('utf8');
      if (cmd.includes(lockPath)) found.push(Number(pid));
    } catch {
      // The process exited between readdir and read.
    }
  }
  return found;
}

describe('lock helper death', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (servers.length) await servers.pop()?.close();
  });

  it('stops signing and exits non-zero when the helper is killed', async () => {
    if (process.platform !== 'linux') return;
    const root = await mkdtemp(join(tmpdir(), 'flock-exit-'));
    const nonceStorePath = join(root, 'n');
    const lockPath = `${nonceStorePath}.lock`;
    const verifier = generateEd25519KeyPair();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
    const first = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath,
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    });
    servers.push(first);
    const pids = pidsForLock(lockPath);
    expect(pids, 'the pinned helper should be a child of this process').toHaveLength(1);
    const helperCmd = readFileSync(`/proc/${pids[0]}/cmdline`).toString('utf8');
    expect(helperCmd.startsWith('/proc/self/fd/'), 'the helper must be execd from the checked descriptor').toBe(true);
    process.kill(pids[0]!, 'SIGKILL');
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    await expect(first.handle(request(verifier, 1))).rejects.toThrow(/nonce lock lost/);

    const second = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a2'),
      nonceStorePath,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: PAYEE, selectors: ['0x'], roles: ['recipient'] }] },
    });
    servers.push(second);
    const signed = await second.handle(request(verifier, 2));
    expect(signed.signedTransaction).toBeTruthy();
  });
});

function request(verifier: { privateKey: string; publicKey: string }, nonce: number): CanonicalSigningRequest {
  const tx: ApprovedTransaction = {
    to: PAYEE,
    value: '1',
    data: '0x',
    chainId: CHAIN,
    nonce: '0',
    gasLimit: '100000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '25000000000',
    type: 0,
  };
  const now = Date.now();
  const intent: SigningIntent = {
    version: '1',
    intentId: `lock-lost-${nonce}`,
    nonce: String(nonce),
    createdAt: now,
    expiresAt: now + 300_000,
    wallet: W,
    chainId: CHAIN,
    venue: 'avalanche',
    action: 'transfer',
    routeHash: computeApprovedTxHash(tx),
    tx,
    tokenIn: { address: '0x0000000000000000000000000000000000000000', symbol: 'AVAX', decimals: 18 },
    amountIn: '1',
  };
  const approval = signVerifierApproval({
    intent,
    verifierPrivateKey: verifier.privateKey,
    verifierPublicKey: verifier.publicKey,
  });
  return {
    requestId: `lock-lost-${nonce}`,
    kind: 'transaction',
    chainId: CHAIN,
    from: W,
    to: PAYEE,
    value: '1',
    data: '0x',
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'x',
    structuredIntent: intent,
    approval,
  };
}
