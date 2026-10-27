import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet } from 'ethers';
import { computeApprovedTxHash, generateEd25519KeyPair, signVerifierApproval, startSignerServer } from '../../src/index';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const W = new Wallet(KEY).address;
const CHAIN = 43114;
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const DEX = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4';
const VAULT = '0x000000000000000000000000000000000000fa17';
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()?.close(); });
async function boot(allow: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'roles-'));
  const verifier = generateEd25519KeyPair();
  const server = await startSignerServer({ privateKey: KEY, verifierPublicKey: verifier.publicKey, token: 't', auditLogPath: join(root, 'a'), nonceStorePath: join(root, 'n'), initNonces: true, allowInsecureFilePermissions: true, chainId: CHAIN, port: 0, simulate: async () => ({ success: true }), allow: { [CHAIN]: allow } } as never);
  servers.push(server);
  return { server, verifier };
}
let n = 0;
function req(h: { verifier: { privateKey: string; publicKey: string } }, to: string, data: string, value = '0', o: Partial<SigningIntent> = {}) {
  const tx: ApprovedTransaction = { to, value, data: data.toLowerCase(), chainId: CHAIN, nonce: '0', gasLimit: '100000', maxFeePerGas: '0', maxPriorityFeePerGas: '0', gasPrice: '25000000000', type: 0 };
  const now = Date.now(); n += 1;
  const intent: SigningIntent = { version: '1', intentId: `i${n}`, nonce: String(n), createdAt: now, expiresAt: now + 300_000, wallet: W, chainId: CHAIN, venue: 'avalanche', action: 'transfer', routeHash: computeApprovedTxHash(tx), tx, ...o };
  const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
  return { requestId: `r${n}`, kind: 'transaction', chainId: CHAIN, from: W, to, value, data: tx.data, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice, maxFeePerGas: '0', maxPriorityFeePerGas: '0', nonce: 0, type: 0, intent: 'x', structuredIntent: intent, approval } as CanonicalSigningRequest;
}
const ERC20 = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const V4626 = new Interface(['function deposit(uint256,address)']);

describe('allow roles', () => {
  it('V1: a native send requires the recipient role', async () => {
    const h = await boot([{ address: DEX, selectors: ['0x'], roles: ['dex'] }]);
    await expect(h.server.handle(req(h, DEX, '0x', '1000000000000000', { tokenIn: { address: '0x0000000000000000000000000000000000000000', symbol: 'AVAX', decimals: 18 }, amountIn: '1000000000000000' }))).rejects.toThrow(/recipient/);
  });
  it('V2: ERC-20 transfer to a recipient-role address that is also a dex is signed (roles are additive)', async () => {
    const h = await boot([{ address: USDC, selectors: ['0xa9059cbb'], roles: ['token'], decimals: 6 }, { address: DEX, selectors: [], roles: ['dex', 'recipient'] }]);
    const res = await h.server.handle(req(h, USDC, ERC20.encodeFunctionData('transfer', [DEX, 1_000_000n]), '0', { tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 }, amountIn: '1000000' }));
    expect(res.signedTransaction).toBeTruthy();
  });
  it('R1: approve to a dex that lacks the spender role is denied', async () => {
    const h = await boot([{ address: USDC, selectors: ['0x095ea7b3'], roles: ['token'], decimals: 6 }, { address: DEX, selectors: [], roles: ['dex'] }]);
    await expect(h.server.handle(req(h, USDC, ERC20.encodeFunctionData('approve', [DEX, 1_000_000n]), '0', { action: 'approve', tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 }, amountIn: '1000000' }))).rejects.toThrow(/spender/);
  });
  it('R2: transfer on a contract without the token role is denied', async () => {
    const h = await boot([{ address: VAULT, selectors: ['0xa9059cbb'], roles: ['vault'] }, { address: DEX, selectors: [], roles: ['recipient'] }]);
    await expect(h.server.handle(req(h, VAULT, ERC20.encodeFunctionData('transfer', [DEX, 1n]), '0', { tokenIn: { address: VAULT, symbol: 'V', decimals: 18 }, amountIn: '1' }))).rejects.toThrow(/token/);
  });
  it('R3: deposit into a non-vault is denied', async () => {
    const h = await boot([{ address: USDC, selectors: ['0x6e553f65'], roles: ['token'] }]);
    await expect(h.server.handle(req(h, USDC, V4626.encodeFunctionData('deposit', [1n, W]), '0', { amountIn: '1' }))).rejects.toThrow(/vault/);
  });
});
