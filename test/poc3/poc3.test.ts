/**
 * Third-round regressions. P1–P4 were signed at f2b4707. Each one must be rejected.
 */
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet } from 'ethers';
import { computeApprovedTxHash, generateEd25519KeyPair, signVerifierApproval, startSignerServer } from '../../src/index';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';
import { readSecureFile } from '../../src/signer/secure-path';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const W = new Wallet(KEY).address;
const CHAIN = 43114;
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';
const DEX = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

async function boot(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'poc3-'));
  const verifier = generateEd25519KeyPair();
  const server = await startSignerServer({
    privateKey: KEY,
    verifierPublicKey: verifier.publicKey,
    token: 't',
    auditLogPath: join(root, 'a.jsonl'),
    nonceStorePath: join(root, 'n.json'),
    initNonces: true,
    allowInsecureFilePermissions: true,
    chainId: CHAIN,
    port: 0,
    simulate: async () => ({ success: true }),
    tokenCaps: { [USDC]: '1000000', [WAVAX]: '1000000000000000000' },
    allow: {
      [CHAIN]: [
        { address: DIAMOND, selectors: ['0x4630a0d8'] },
        { address: DEX, selectors: ['0x38ed1739'], roles: ['dex', 'spender'] },
        { address: USDC, selectors: ['0x095ea7b3', '0xa9059cbb'], decimals: 6, roles: ['token'] },
        { address: WAVAX, selectors: ['0x095ea7b3'], decimals: 18, roles: ['token'] },
      ],
    },
    ...extra,
  } as never);
  servers.push(server);
  return { server, verifier };
}

let n = 0;
function build(h: Awaited<ReturnType<typeof boot>>, to: string, data: string, o: Partial<SigningIntent> = {}) {
  const tx: ApprovedTransaction = {
    to, value: '0', data: data.toLowerCase(), chainId: CHAIN, nonce: '0', gasLimit: '300000',
    maxFeePerGas: '0', maxPriorityFeePerGas: '0', gasPrice: '30000000000', type: 0,
  };
  const now = Date.now();
  n += 1;
  const intent: SigningIntent = {
    version: '1', intentId: `i${n}`, nonce: String(n), createdAt: now, expiresAt: now + 300_000,
    wallet: W, chainId: CHAIN, venue: 'lifi', action: 'swap',
    tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    tokenOut: { address: USDC, symbol: 'USDC', decimals: 6 },
    amountIn: '1000000', minAmountOut: '1', routeHash: computeApprovedTxHash(tx), tx, ...o,
  };
  const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
  const req: CanonicalSigningRequest = {
    requestId: `r${n}`, kind: 'transaction', chainId: CHAIN, from: W, to: tx.to, value: tx.value,
    data: tx.data, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice, maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas, nonce: 0, type: 0, intent: 'x',
    structuredIntent: intent, approval,
  };
  return req;
}

const LIFI = new Interface(['function swapTokensGeneric(bytes32,string,string,address,uint256,tuple(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[])']);
const ERC20 = new Interface(['function transfer(address,uint256)']);

describe('third-round signer regressions', () => {
  it('P1: a later leg with requiresDeposit set is denied', async () => {
    const h = await boot();
    const legs = [
      [DEX, DEX, USDC, WAVAX, 1_000_000n, '0x', true],
      [DEX, DEX, WAVAX, USDC, 1000n * 10n ** 18n, '0x', true],
    ];
    const data = LIFI.encodeFunctionData('swapTokensGeneric', ['0x' + '00'.repeat(32), 'x', 'x', W, 1n, legs]);
    await expect(h.server.handle(build(h, DIAMOND, data))).rejects.toThrow(/requiresDeposit/);
  });

  it('P2: a token address cannot be callTo', async () => {
    const h = await boot();
    const inner = ERC20.encodeFunctionData('transfer', [ATTACKER, 1_000_000n]);
    const legs = [[USDC, USDC, USDC, WAVAX, 1_000_000n, inner, true]];
    const data = LIFI.encodeFunctionData('swapTokensGeneric', ['0x' + '00'.repeat(32), 'x', 'x', W, 1n, legs]);
    await expect(h.server.handle(build(h, DIAMOND, data, { tokenOut: { address: WAVAX, symbol: 'WAVAX', decimals: 18 } }))).rejects.toThrow(/callTo|token/);
  });

  it('P3: an ERC-20 transfer recipient must have the recipient role', async () => {
    const h = await boot();
    const data = ERC20.encodeFunctionData('transfer', [WAVAX, 1_000_000n]);
    await expect(h.server.handle(build(h, USDC, data, { action: 'transfer', minAmountOut: undefined, tokenOut: undefined }))).rejects.toThrow(/recipient/);
  });

  it('P4: a root-owned file reached through a symlinked directory is denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poc3-'));
    await symlink('/etc', join(root, 'cfgdir'));
    await expect(readSecureFile(join(root, 'cfgdir', 'hostname'))).rejects.toThrow(/symlink/);
  });
});
