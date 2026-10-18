/**
 * Second-review regressions. The N cases are the attacks that were signed at
 * 53459ec. Each one must now be rejected. The R cases are the checks that
 * already held and must keep holding.
 */
import { mkdtemp, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet } from 'ethers';
import { computeApprovedTxHash, computeRequestRouteHash, generateEd25519KeyPair, signVerifierApproval, startSignerServer } from '../../src/index';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const W = new Wallet(KEY).address;
const CHAIN = 43114;
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const JUNK = '0x00000000000000000000000000000000DeaDBeef';
const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

async function boot(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'poc2-'));
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
    allow: {
      [CHAIN]: [
        { address: DIAMOND, selectors: ['0x4630a0d8', '0xac9650d8'] },
        { address: USDC, selectors: ['0x095ea7b3', '0xac9650d8'], decimals: 6 },
      ],
    },
    ...extra,
  } as never);
  servers.push(server);
  return { server, verifier };
}
let n = 0;
function build(h: Awaited<ReturnType<typeof boot>>, to: string, data: string, o: Partial<SigningIntent> = {}, txo: Partial<ApprovedTransaction> = {}) {
  const tx: ApprovedTransaction = { to, value: '0', data: data.toLowerCase(), chainId: CHAIN, nonce: '0', gasLimit: '300000', maxFeePerGas: '0', maxPriorityFeePerGas: '0', gasPrice: '30000000000', type: 0, ...txo };
  const now = Date.now();
  n += 1;
  const intent: SigningIntent = {
    version: '1',
    intentId: `i${n}`,
    nonce: String(n),
    createdAt: now,
    expiresAt: now + 300_000,
    wallet: W,
    chainId: CHAIN,
    venue: 'lifi',
    action: 'swap',
    tokenIn: { address: USDC, symbol: 'USDC', decimals: 6 },
    amountIn: '1000000',
    minAmountOut: '1',
    routeHash: computeApprovedTxHash(tx),
    tx,
    ...o,
  };
  const mode = (h as { mode?: 'live' | 'dry-run' }).mode ?? 'live';
  const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey, mode });
  const req: CanonicalSigningRequest = {
    requestId: `r${n}`,
    kind: 'transaction',
    chainId: CHAIN,
    from: W,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: Number(tx.nonce),
    type: tx.type,
    intent: 'x',
    structuredIntent: intent,
    approval,
  };
  return req;
}
const LIFI = new Interface(['function swapTokensGeneric(bytes32,string,string,address,uint256,tuple(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[])', 'function multicall(bytes[])']);
const ERC20 = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)']);
const leg = (from: string, toAsset: string, amt: bigint) => [ATTACKER, ATTACKER, from, toAsset, amt, '0x', true];

describe('second-review signer regressions', () => {
  it('N1: a Li.Fi swap to a junk receivingAsset is denied', async () => {
    const h = await boot();
    const data = LIFI.encodeFunctionData('swapTokensGeneric', ['0x' + '00'.repeat(32), 'x', 'x', W, 1n, [leg(USDC, JUNK, 1_000_000n)]]);
    await expect(h.server.handle(build(h, DIAMOND, data, { tokenOut: { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX', decimals: 18 } }))).rejects.toThrow(/receivingAsset|callTo|allowlist/i);
  });

  it('N2: Li.Fi legs are not accepted by summing fromAmount across assets', async () => {
    const h = await boot();
    const data = LIFI.encodeFunctionData('swapTokensGeneric', ['0x' + '00'.repeat(32), 'x', 'x', W, 1n, [leg(USDC, JUNK, 400_000n), leg(JUNK, USDC, 600_000n)]]);
    await expect(h.server.handle(build(h, DIAMOND, data))).rejects.toThrow(/fromAmount|tokenOut|callTo|receivingAsset/i);
  });

  it('N3: a USDC cap applies to the sold asset of a Li.Fi swap, not the diamond', async () => {
    const h = await boot({ tokenCaps: { [USDC]: '1000000' } });
    const amt = 5_000_000_000_000n;
    const data = LIFI.encodeFunctionData('swapTokensGeneric', ['0x' + '00'.repeat(32), 'x', 'x', W, 1n, [leg(USDC, JUNK, amt)]]);
    await expect(h.server.handle(build(h, DIAMOND, data, { amountIn: amt.toString() }))).rejects.toThrow(/oversize|callTo|allowlist|tokenOut/i);
  });

  it('N4: approve to an arbitrary spender is denied', async () => {
    const h = await boot();
    const data = ERC20.encodeFunctionData('approve', [ATTACKER, 1_000_000n]);
    await expect(h.server.handle(build(h, USDC, data, { action: 'approve', minAmountOut: undefined }))).rejects.toThrow(/spender|allowlist/i);
  });

  it('N5: a multicall inner transfer is denied when its selector or recipient is not allowlisted', async () => {
    const h = await boot();
    const inner = ERC20.encodeFunctionData('transfer', [ATTACKER, 1_000_000n]);
    const data = LIFI.encodeFunctionData('multicall', [[inner]]);
    await expect(h.server.handle(build(h, USDC, data, { action: 'transfer', minAmountOut: undefined }))).rejects.toThrow(/allowlist|recipient/i);
  });

  it('N6: Polymarket typed data is denied even when the domain is allowlisted', async () => {
    const h = await boot({ typedDataAllow: [{ domainName: 'Polymarket CTF Exchange', primaryType: 'Order' }] });
    const typedData = {
      domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
      types: { Order: [{ name: 'maker', type: 'address' }, { name: 'makerAmount', type: 'uint256' }, { name: 'side', type: 'uint8' }] },
      value: { maker: W, makerAmount: '1000000', side: 0 },
    };
    const req = { requestId: 'pm', kind: 'typed-data' as const, chainId: CHAIN, from: W, intent: 'x', typedData };
    const now = Date.now();
    const intent: SigningIntent = {
      version: '1',
      intentId: 'pm',
      nonce: '999',
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: W,
      chainId: CHAIN,
      venue: 'avalanche',
      action: 'sign',
      routeHash: computeRequestRouteHash(req),
    };
    const approval = signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey });
    await expect(h.server.handle({ ...req, structuredIntent: intent, approval })).rejects.toThrow(/Polymarket/i);
  });

  it('N7: a small-order verifier pubkey is rejected at startup', async () => {
    const identity = '0x01' + '00'.repeat(31);
    const root = await mkdtemp(join(tmpdir(), 'poc2-'));
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: identity,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: USDC, selectors: ['0x095ea7b3'], decimals: 6 }] },
    } as never)).rejects.toThrow(/small-order|Verifier public key/i);
  });

  it('N8: a config symlink in a world-writable directory is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poc2-'));
    await chmod(root, 0o777);
    const link = join(root, 'signer.json');
    await symlink('/etc/hostname', link);
    const verifier = generateEd25519KeyPair();
    await expect(startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      configPath: link,
      token: 't',
      auditLogPath: join(root, 'a'),
      nonceStorePath: join(root, 'n'),
      initNonces: true,
      chainId: CHAIN,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: { [CHAIN]: [{ address: USDC, selectors: ['0x095ea7b3'] }] },
    } as never)).rejects.toThrow(/symlink|root|writable/i);
  });

  for (const [field, val] of [['to', ATTACKER], ['value', '1'], ['gasPrice', '30000000001'], ['type', 2], ['chainId', 1], ['nonce', 5], ['maxFeePerGas', '1']] as const) {
    it(`R-${field}: tampering ${field} after approval is denied`, async () => {
      const h = await boot({ chainIds: [CHAIN, 1] });
      const data = ERC20.encodeFunctionData('approve', [DIAMOND, 1_000_000n]);
      const req = build(h, USDC, data, { action: 'approve', minAmountOut: undefined });
      (req as unknown as Record<string, unknown>)[field] = val;
      await expect(h.server.handle(req)).rejects.toThrow(/does not match|not allowed/);
    });
  }

  it('R-dry: dry-run still requires a valid verifier signature', async () => {
    const h = await boot({ dryRun: true });
    (h as { mode?: string }).mode = 'dry-run';
    const data = ERC20.encodeFunctionData('approve', [DIAMOND, 1_000_000n]);
    const req = build(h, USDC, data, { action: 'approve', minAmountOut: undefined });
    req.approval!.signature = '0x' + '00'.repeat(64);
    await expect(h.server.handle(req)).rejects.toThrow(/signature is invalid/);
  });

  it('R-empty: empty verifierPublicKey refuses to start', async () => {
    await expect(boot({ verifierPublicKey: '' })).rejects.toThrow(/verifier/i);
  });
});
