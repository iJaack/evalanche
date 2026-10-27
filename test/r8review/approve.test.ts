import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { chmod } from 'node:fs/promises';
import { Interface, MaxUint256, Wallet, getAddress, verifyMessage } from 'ethers';
import {
  Evalanche,
  EvalancheError,
  EvalancheErrorCode,
  canonicalIntentJson,
  computeApprovedTxHash,
  computeIntentHash,
  computeRequestRouteHash,
  generateEd25519KeyPair,
  signVerifierApproval,
  startSignerServer,
} from '../../src/index';
import { RemoteSignerClient } from '../../src/signer/remote-client';
import type { ApprovedTransaction, CanonicalSigningRequest, SigningIntent } from '../../src/signer/intent';
import type { AllowEntry, EvalancheSignerServer, SignerServerOptions } from '../../src/signer/server';

const TREASURY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CHAIN_ID = 43114;
const SPEND = '0x000000000000000000000000000000000000bEEF';
const TOKEN = '0x0000000000000000000000000000000000000001';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

async function dirs(): Promise<{ audit: string; nonce: string }> {
  const root = await mkdtemp(join(tmpdir(), 'evalanche-signer-'));
  return { audit: join(root, 'audit.jsonl'), nonce: join(root, 'nonces.json') };
}

const ALLOW: Record<string, AllowEntry[]> = {
  [CHAIN_ID]: [
    { address: SPEND, selectors: ['0x', '0xa9059cbb', '0x095ea7b3', '0x6e553f65', '0x4630a0d8', '0xac9650d8'], decimals: 18, roles: ['dex', 'spender', 'recipient', 'vault'] },
    { address: TOKEN, selectors: ['0x', '0xa9059cbb', '0x095ea7b3'], decimals: 6, roles: ['token'] },
  ],
};

function boundTx(request: Pick<CanonicalSigningRequest, 'to' | 'value' | 'data' | 'chainId' | 'nonce' | 'gasLimit' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice' | 'type'>): ApprovedTransaction {
  return {
    to: getAddress(request.to ?? SPEND),
    value: request.value ?? '0',
    data: (request.data && request.data.length > 0 ? request.data : '0x').toLowerCase(),
    chainId: request.chainId ?? CHAIN_ID,
    nonce: String(request.nonce ?? 0),
    gasLimit: request.gasLimit ?? '21000',
    maxFeePerGas: request.maxFeePerGas ?? '0',
    maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? '0',
    gasPrice: request.gasPrice ?? '1000000000',
    type: request.type ?? 0,
  };
}

function intent(wallet: string, data: string, overrides: Partial<SigningIntent> = {}, requestOverrides: Partial<CanonicalSigningRequest> = {}): SigningIntent {
  const request = { ...txRequest(wallet, data), ...requestOverrides };
  const tx = boundTx(request);
  const now = Date.now();
  const native = (request.data ?? '0x') === '0x';
  const built: SigningIntent = {
    version: '1',
    intentId: 'intent-1',
    nonce: '1',
    createdAt: now,
    expiresAt: now + 60_000,
    wallet,
    chainId: CHAIN_ID,
    venue: 'spot',
    action: 'send',
    tokenIn: { address: TOKEN, symbol: 'USDC', decimals: 6 },
    amountIn: native ? (request.value ?? '0') : '1000000',
    minAmountOut: '990000',
    maxSlippageBps: 100,
    tier: 'core',
    sleeve: 'cash',
    sizePctOfTreasury: 1,
    postFrictionEvUsd: '0',
    signalRefs: ['sig-1'],
    routeHash: computeApprovedTxHash(tx),
    tx,
    ...overrides,
  };
  built.wallet = overrides.wallet ?? wallet;
  built.tx = overrides.tx === undefined ? tx : overrides.tx;
  if (built.tx && overrides.routeHash === undefined) built.routeHash = computeApprovedTxHash(built.tx);
  else if (overrides.routeHash) built.routeHash = overrides.routeHash;
  return built;
}

function txRequest(from: string, data = '0x'): CanonicalSigningRequest {
  const body: CanonicalSigningRequest = {
    requestId: 'req-1',
    kind: 'transaction',
    chainId: CHAIN_ID,
    from,
    to: SPEND,
    value: '0',
    data,
    gasLimit: '21000',
    gasPrice: '1000000000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'send a bounded transfer',
  };
  return body;
}

async function boot(opts: {
  dryRun?: boolean;
  tokenCaps?: Record<string, string>;
  maxPerTxUsd?: number;
  prices?: Record<string, number>;
  allow?: Record<string, AllowEntry[]>;
  messageAllowlist?: string[];
  privateKey?: string;
  verifier?: ReturnType<typeof generateEd25519KeyPair>;
  paths?: { audit: string; nonce: string };
} = {}) {
  const paths = opts.paths ?? await dirs();
  const verifier = opts.verifier ?? generateEd25519KeyPair();
  const wallet = new Wallet(opts.privateKey ?? TREASURY_KEY);
  const server = await startSignerServer({
    privateKey: wallet.privateKey,
    verifierPublicKey: verifier.publicKey,
    token: 'test-token',
    auditLogPath: paths.audit,
    nonceStorePath: paths.nonce,
    chainId: CHAIN_ID,
    port: 0,
    dryRun: opts.dryRun,
    tokenCaps: opts.tokenCaps,
    maxPerTxUsd: opts.maxPerTxUsd,
    prices: opts.prices,
    allow: opts.allow ?? ALLOW,
    messageAllowlist: opts.messageAllowlist,
    initNonces: !opts.paths,
    allowInsecureFilePermissions: true,
    simulate: async () => ({ success: true }),
  });
  servers.push(server);
  return { server, verifier, wallet, paths, dryRun: Boolean(opts.dryRun) };
}

function clientFor(server: EvalancheSignerServer & { port?: number }, address: string): RemoteSignerClient {
  return new RemoteSignerClient({
    url: `http://127.0.0.1:${server.port}`,
    address,
    token: 'test-token',
    timeoutMs: 5_000,
  });
}

async function signTx(
  harness: Awaited<ReturnType<typeof boot>>,
  build: SigningIntent,
  request: CanonicalSigningRequest,
) {
  const approval = signVerifierApproval({
    intent: build,
    verifierPrivateKey: harness.verifier.privateKey,
    verifierPublicKey: harness.verifier.publicKey,
    mode: harness.dryRun ? 'dry-run' : 'live',
  });
  return harness.server.handle({ ...request, structuredIntent: build, approval });
}

describe('R8 review: approvals', () => {
  const iface = new Interface(['function approve(address spender, uint256 amount)']);
  const NOT_SPENDER = '0x000000000000000000000000000000000000dEaD';
  it('A1 approve(spender,0) passes; approve(non-spender,0) fails', async () => {
    const h = await boot();
    const zero = iface.encodeFunctionData('approve', [SPEND, 0n]);
    const ok = await signTx(h, intent(h.wallet.address, zero, { nonce: '11', action: 'approve', amountIn: '0', minAmountOut: undefined }, { to: TOKEN }), { ...txRequest(h.wallet.address, zero), to: TOKEN, requestId: 'a1' });
    expect(ok.signedTransaction).toMatch(/^0x/);
    const bad = iface.encodeFunctionData('approve', [NOT_SPENDER, 0n]);
    await expect(signTx(h, intent(h.wallet.address, bad, { nonce: '12', action: 'approve', amountIn: '0', minAmountOut: undefined }, { to: TOKEN }), { ...txRequest(h.wallet.address, bad), to: TOKEN, requestId: 'a1b' })).rejects.toThrow(/spender/i);
  });
  it('A2 over-cap approval fails (token cap and USD cap); MaxUint256-1 over cap fails', async () => {
    const h = await boot({ tokenCaps: { [getAddress(TOKEN).toLowerCase()]: '1000' }, maxPerTxUsd: 1, prices: { [getAddress(TOKEN).toLowerCase()]: 1 } });
    for (const [n, amt] of [['21', 1001n], ['22', MaxUint256 - 1n]] as const) {
      const d = iface.encodeFunctionData('approve', [SPEND, amt]);
      await expect(signTx(h, intent(h.wallet.address, d, { nonce: n, action: 'approve', amountIn: amt.toString(), minAmountOut: undefined }, { to: TOKEN }), { ...txRequest(h.wallet.address, d), to: TOKEN, requestId: 'a2' + n })).rejects.toThrow(/cap|oversize|exceed/i);
    }
    const d = iface.encodeFunctionData('approve', [SPEND, 1000n]);
    const ok = await signTx(h, intent(h.wallet.address, d, { nonce: '23', action: 'approve', amountIn: '1000', minAmountOut: undefined }, { to: TOKEN }), { ...txRequest(h.wallet.address, d), to: TOKEN, requestId: 'a23' });
    expect(ok.signedTransaction).toMatch(/^0x/);
  });
});
