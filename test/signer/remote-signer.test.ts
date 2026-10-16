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
const CHAIN_ID = 43113;
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
    { address: SPEND, selectors: ['0x', '0xa9059cbb', '0x095ea7b3', '0x6e553f65', '0x4630a0d8', '0xac9650d8'], decimals: 18 },
    { address: TOKEN, selectors: ['0x', '0xa9059cbb', '0x095ea7b3'], decimals: 6 },
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

describe('canonical intent', () => {
  it('sorts keys and hashes the canonical JSON', () => {
    const wallet = getAddress(new Wallet(TREASURY_KEY).address);
    const built = intent(wallet, '0x1234', { intentId: 'z', venue: 'spot' });
    const json = canonicalIntentJson(built);
    expect(json.indexOf('"action"')).toBeLessThan(json.indexOf('"venue"'));
    expect(json.indexOf('"address"')).toBeLessThan(json.indexOf('"decimals"'));
    expect(computeIntentHash(built)).toMatch(/^0x[0-9a-f]{64}$/);
    const swapped = JSON.parse(json) as SigningIntent;
    expect(computeIntentHash(swapped)).toBe(computeIntentHash(built));
  });
});

describe('remote signer', () => {
  it('signs a transaction only when the approval matches the tx', async () => {
    const harness = await boot();
    const data = '0x';
    const built = intent(harness.wallet.address, data);
    const request = txRequest(harness.wallet.address, data);
    request.requestId = 'happy-path';
    const result = await signTx(harness, built, request);
    expect(result.signedTransaction?.startsWith('0x')).toBe(true);
    const client = clientFor(harness.server, harness.wallet.address);
    const viaHttp = await client.signTransaction({ ...request, requestId: 'http-1', structuredIntent: { ...built, nonce: '2' }, approval: signVerifierApproval({
      intent: { ...built, nonce: '2' },
      verifierPrivateKey: harness.verifier.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
    }) });
    expect(viaHttp.signedTransaction?.startsWith('0x')).toBe(true);
  });

  it('signs a message through Evalanche without a local private key', async () => {
    const harness = await boot({ messageAllowlist: ['ops-approved'] });
    const message = 'ops-approved';
    const requestBase = {
      kind: 'message' as const,
      chainId: CHAIN_ID,
      from: harness.wallet.address,
      message,
    };
    const built = intent(harness.wallet.address, '0x', {
      action: 'sign-message',
      routeHash: computeRequestRouteHash({ ...requestBase, data: undefined }),
      minAmountOut: undefined,
      amountIn: undefined,
      tokenIn: undefined,
    });
    const agent = new Evalanche({
      signer: {
        url: `http://127.0.0.1:${harness.server.port}`,
        address: harness.wallet.address,
        token: 'test-token',
      },
      network: 'fuji',
    });
    expect(agent.signerMode).toBe('remote');
    expect(agent.getLocalPrivateKey()).toBeUndefined();
    const signature = await agent.signMessage(message, {
      intent: 'sign the ops message',
      structuredIntent: built,
      approval: signVerifierApproval({
        intent: built,
        verifierPrivateKey: harness.verifier.privateKey,
        verifierPublicKey: harness.verifier.publicKey,
      }),
    });
    expect(verifyMessage(message, signature)).toBe(harness.wallet.address);
  });

  it('rejects a wrong intent hash', async () => {
    const harness = await boot();
    const data = '0x11';
    const built = intent(harness.wallet.address, data);
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: harness.verifier.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
    });
    const tampered = { ...built, amountIn: '2' };
    await expect(harness.server.handle({
      ...txRequest(harness.wallet.address, data),
      structuredIntent: tampered,
      approval,
    })).rejects.toThrow(/wrong hash/i);
  });

  it('rejects a route hash that does not match the transaction data', async () => {
    const harness = await boot();
    const built = intent(harness.wallet.address, '0x11');
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: harness.verifier.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
    });
    await expect(harness.server.handle({
      ...txRequest(harness.wallet.address, '0x22'),
      structuredIntent: built,
      approval,
    })).rejects.toThrow(/routeHash|does not match/i);
  });

  it('rejects a replayed nonce and an expired approval', async () => {
    const harness = await boot();
    const data = '0x';
    const first = intent(harness.wallet.address, data, { nonce: '1' });
    await signTx(harness, first, txRequest(harness.wallet.address, data));
    await expect(signTx(harness, first, { ...txRequest(harness.wallet.address, data), requestId: 'replay' }))
      .rejects.toThrow(/replayed nonce/i);

    await harness.server.close();
    const restarted = await startSignerServer({
      privateKey: harness.wallet.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
      token: 'test-token',
      auditLogPath: harness.paths.audit,
      nonceStorePath: harness.paths.nonce,
      chainId: CHAIN_ID,
      port: 0,
      allow: ALLOW,
      allowInsecureFilePermissions: true,
      simulate: async () => ({ success: true }),
    });
    servers.push(restarted);
    await expect(restarted.handle({
      ...txRequest(harness.wallet.address, data),
      requestId: 'replay-after-restart',
      structuredIntent: first,
      approval: signVerifierApproval({
        intent: first,
        verifierPrivateKey: harness.verifier.privateKey,
        verifierPublicKey: harness.verifier.publicKey,
      }),
    })).rejects.toThrow(/replayed nonce/i);

    const expired = intent(harness.wallet.address, data, { nonce: '2', expiresAt: Date.now() - 1_000 });
    await expect(signTx(harness, expired, { ...txRequest(harness.wallet.address, data), requestId: 'expired' }))
      .rejects.toThrow(/expired/i);
  });

  it('rejects a bad signature and a wrong verifier key', async () => {
    const harness = await boot();
    const data = '0x';
    const built = intent(harness.wallet.address, data, { nonce: '3' });
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: harness.verifier.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
    });
    const flipped = `${approval.signature.slice(0, -2)}00`;
    await expect(harness.server.handle({
      ...txRequest(harness.wallet.address, data),
      requestId: 'bad-sig',
      structuredIntent: built,
      approval: { ...approval, signature: flipped },
    })).rejects.toThrow(/signature/i);

    const other = generateEd25519KeyPair();
    const foreign = signVerifierApproval({
      intent: built,
      verifierPrivateKey: other.privateKey,
      verifierPublicKey: other.publicKey,
    });
    await expect(harness.server.handle({
      ...txRequest(harness.wallet.address, data),
      requestId: 'wrong-verifier',
      structuredIntent: built,
      approval: foreign,
    })).rejects.toThrow(/wrong verifier/i);
  });

  it('rejects a denied selector, an unlimited approval, and an oversize amount', async () => {
    const denied = await boot();
    const data = '0xdeadbeef';
    const built = intent(denied.wallet.address, data, { nonce: '4', action: 'call' });
    await expect(signTx(denied, built, txRequest(denied.wallet.address, data))).rejects.toThrow(/allowlist|denied/i);

    const iface = new Interface(['function approve(address spender, uint256 amount)']);
    const unlimited = iface.encodeFunctionData('approve', [SPEND, MaxUint256]);
    const unlimitedIntent = intent(denied.wallet.address, unlimited, {
      nonce: '5',
      action: 'approve',
      amountIn: MaxUint256.toString(),
    }, { to: TOKEN });
    await expect(signTx(denied, unlimitedIntent, { ...txRequest(denied.wallet.address, unlimited), to: TOKEN })).rejects.toThrow(/unlimited/i);

    const exact = iface.encodeFunctionData('approve', [SPEND, 1000n]);
    const mismatched = intent(denied.wallet.address, exact, { nonce: '6', action: 'approve', amountIn: '1001' }, { to: TOKEN });
    await expect(signTx(denied, mismatched, { ...txRequest(denied.wallet.address, exact), to: TOKEN })).rejects.toThrow(/amountIn/i);

    const matched = intent(denied.wallet.address, exact, { nonce: '7', action: 'approve', amountIn: '1000' }, { to: TOKEN });
    const ok = await signTx(denied, matched, { ...txRequest(denied.wallet.address, exact), to: TOKEN, requestId: 'exact-approve' });
    expect(ok.signedTransaction).toMatch(/^0x/);

    const transfer = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [SPEND, 10_000_000n]);
    const capped = await boot({
      tokenCaps: { [getAddress(TOKEN).toLowerCase()]: '10' },
      maxPerTxUsd: 1,
      prices: { [getAddress(TOKEN).toLowerCase()]: 1 },
    });
    const fat = intent(capped.wallet.address, transfer, { nonce: '1', amountIn: '10000000', action: 'transfer' }, { to: TOKEN });
    await expect(signTx(capped, fat, { ...txRequest(capped.wallet.address, transfer), to: TOKEN })).rejects.toThrow(/oversize/i);
  });

  it('rejects a decoded transaction that does not match the request', async () => {
    const wallet = new Wallet(TREASURY_KEY);
    const evil = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const http = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CanonicalSigningRequest;
        const signedTransaction = await wallet.signTransaction({
          to: '0x00000000000000000000000000000000000000aa',
          value: 0,
          data: body.data,
          chainId: body.chainId,
          nonce: body.nonce,
          gasLimit: BigInt(body.gasLimit ?? '21000'),
          gasPrice: BigInt(body.gasPrice ?? '1'),
          type: body.type,
        });
        const payload = JSON.stringify({ requestId: body.requestId, signedTransaction });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      });
      http.listen(0, '127.0.0.1', () => {
        const address = http.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise((done) => http.close(() => done())),
        });
      });
    });
    servers.push(evil);
    const remote = new RemoteSignerClient({ url: evil.url, address: wallet.address, token: 'ignored' });
    const data = '0x';
    const built = intent(wallet.address, data);
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: generateEd25519KeyPair().privateKey,
      verifierPublicKey: generateEd25519KeyPair().publicKey,
    });
    await expect(remote.signTransaction({
      ...txRequest(wallet.address, data),
      structuredIntent: built,
      approval,
    })).rejects.toThrow(/does not match/i);
  });

  it('does not sign in dry-run and writes an append-only audit log', async () => {
    const harness = await boot({ dryRun: true });
    const data = '0x';
    const built = intent(harness.wallet.address, data, { nonce: '8' });
    const result = await signTx(harness, built, txRequest(harness.wallet.address, data));
    expect(result.dryRun).toBe(true);
    expect(result.signedTransaction).toBeUndefined();
    expect(result.signature).toBeUndefined();
    const log = await readFile(harness.paths.audit, 'utf8');
    expect(log).toContain('"decision":"dry_run"');
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: harness.verifier.privateKey,
      verifierPublicKey: harness.verifier.publicKey,
    });
    await expect(harness.server.handle({
      ...txRequest(harness.wallet.address, data),
      requestId: 'tampered',
      structuredIntent: { ...built, amountIn: '1' },
      approval,
    })).rejects.toThrow(/wrong hash/i);
    const after = await readFile(harness.paths.audit, 'utf8');
    expect(after.startsWith(log)).toBe(true);
    expect(after).toContain('"decision":"deny"');
  });

  it('denies Hyperliquid order typed data by default', async () => {
    const harness = await boot();
    const typed = {
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      value: { source: 'a', connectionId: '0x' + '11'.repeat(32) },
    };
    const request: CanonicalSigningRequest = {
      requestId: 'hl',
      kind: 'typed-data',
      chainId: CHAIN_ID,
      from: harness.wallet.address,
      intent: 'hyperliquid order',
      typedData: typed,
    };
    const built = intent(harness.wallet.address, '0x', {
      nonce: '9',
      venue: 'hyperliquid',
      action: 'order',
      routeHash: computeRequestRouteHash(request),
      amountIn: undefined,
      tokenIn: undefined,
      minAmountOut: undefined,
    });
    await expect(signTx(harness, built, request)).rejects.toThrow(/hyperliquid|denied/i);
  });

  it('fails key-only paths when a remote signer is configured', async () => {
    const agent = new Evalanche({
      signer: { url: 'http://127.0.0.1:9', address: getAddress(new Wallet(TREASURY_KEY).address), token: 't' },
      network: 'fuji',
    });
    await expect(agent.xChain()).rejects.toMatchObject({ code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED });
    await expect(agent.pChain()).rejects.toMatchObject({ code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED });
    await expect(agent.platformCLI()).rejects.toMatchObject({ code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED });
    const polymarket = await agent.polymarket();
    await expect(polymarket.placeOrder({
      tokenId: '1',
      side: 0 as never,
      price: 0.5,
      size: 1,
    })).rejects.toBeInstanceOf(EvalancheError);
    await expect(polymarket.placeOrder({
      tokenId: '1',
      side: 0 as never,
      price: 0.5,
      size: 1,
    })).rejects.toMatchObject({ code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED });

    const previous = process.env.POLYMARKET_PRIVATE_KEY;
    process.env.POLYMARKET_PRIVATE_KEY = OTHER_KEY;
    try {
      await expect(polymarket.placeOrder({
        tokenId: '1',
        side: 0 as never,
        price: 0.5,
        size: 1,
      })).rejects.toMatchObject({ code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED });
    } finally {
      if (previous === undefined) delete process.env.POLYMARKET_PRIVATE_KEY;
      else process.env.POLYMARKET_PRIVATE_KEY = previous;
    }
  });

  it('serves read-only calls from an address with no key', async () => {
    const address = getAddress(new Wallet(TREASURY_KEY).address);
    const agent = new Evalanche({ address, network: 'fuji' });
    expect(agent.signerMode).toBe('readonly');
    expect(agent.address).toBe(address);
    expect(agent.getChainInfo().id).toBe(43113);
    await expect(agent.signMessage('hello')).rejects.toMatchObject({
      code: EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED,
    });
    expect(() => new Evalanche({
      privateKey: TREASURY_KEY,
      signer: { url: 'http://127.0.0.1:9', address, token: 't' },
      network: 'fuji',
    })).toThrow(/mutually exclusive/);
  });

  it('rejects a swap that omits the minAmountOut bound and a reverted simulation', async () => {
    const harness = await boot();
    const lifi = new Interface([
      'function swapTokensGeneric(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmount, tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[] swapData)',
    ]);
    const data = lifi.encodeFunctionData('swapTokensGeneric', [
      `0x${'11'.repeat(32)}`,
      'evalanche',
      'ops',
      harness.wallet.address,
      0n,
      [[SPEND, SPEND, TOKEN, TOKEN, 1_000_000n, '0x', false]],
    ]);
    const swap = intent(harness.wallet.address, data, {
      action: 'swap',
      minAmountOut: undefined,
      nonce: '11',
      tokenOut: { address: TOKEN, symbol: 'USDC', decimals: 6 },
    });
    await expect(signTx(harness, swap, txRequest(harness.wallet.address, data))).rejects.toThrow(/minAmountOut/);

    const paths = await dirs();
    const verifier = generateEd25519KeyPair();
    const wallet = new Wallet(TREASURY_KEY);
    const reverting = await startSignerServer({
      privateKey: wallet.privateKey,
      verifierPublicKey: verifier.publicKey,
      token: 'test-token',
      auditLogPath: paths.audit,
      nonceStorePath: paths.nonce,
      chainId: CHAIN_ID,
      port: 0,
      allow: ALLOW,
      initNonces: true,
      allowInsecureFilePermissions: true,
      simulate: async () => ({ success: false, revertReason: 'boom' }),
    });
    servers.push(reverting);
    const built = intent(wallet.address, '0x', { nonce: '1' });
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: verifier.privateKey,
      verifierPublicKey: verifier.publicKey,
    });
    await expect(reverting.handle({
      ...txRequest(wallet.address, '0x'),
      structuredIntent: built,
      approval,
    })).rejects.toThrow(/simulation/i);
  });

  it('signs through a unix socket and can load an encrypted keystore', async () => {
    const paths = await dirs();
    const socketDir = join(paths.audit, '..');
    await chmod(socketDir, 0o750);
    const socketPath = join(socketDir, 'signer.sock');
    const verifier = generateEd25519KeyPair();
    const wallet = new Wallet(TREASURY_KEY);
    const server = await startSignerServer({
      privateKey: wallet.privateKey,
      verifierPublicKey: verifier.publicKey,
      token: 'socket-token',
      auditLogPath: paths.audit,
      nonceStorePath: paths.nonce,
      chainId: CHAIN_ID,
      socketPath,
      allow: ALLOW,
      initNonces: true,
      allowInsecureFilePermissions: true,
      simulate: async () => ({ success: true }),
    });
    servers.push(server);
    expect(server.endpoint.startsWith('unix://')).toBe(true);
    const remote = new RemoteSignerClient({
      socketPath,
      address: wallet.address,
      token: 'socket-token',
    });
    const data = '0x';
    const built = intent(wallet.address, data, { nonce: '1' });
    const signed = await remote.signTransaction({
      ...txRequest(wallet.address, data),
      structuredIntent: built,
      approval: signVerifierApproval({
        intent: built,
        verifierPrivateKey: verifier.privateKey,
        verifierPublicKey: verifier.publicKey,
      }),
    });
    expect(signed.signedTransaction).toMatch(/^0x/);

    const keystorePath = join(paths.audit, '..', 'keystore.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(keystorePath, await wallet.encrypt('test-password'));
    const keystorePaths = await dirs();
    process.env.EVALANCHE_SIGNER_KEYSTORE_PASSWORD = 'test-password';
    try {
      const fromKeystore = await startSignerServer({
        keystorePath,
        verifierPublicKey: verifier.publicKey,
        token: 'test-token',
        auditLogPath: keystorePaths.audit,
        nonceStorePath: keystorePaths.nonce,
        chainId: CHAIN_ID,
        port: 0,
        allow: ALLOW,
        initNonces: true,
        allowInsecureFilePermissions: true,
        simulate: async () => ({ success: true }),
      });
      servers.push(fromKeystore);
      expect(fromKeystore.address).toBe(wallet.address);
    } finally {
      delete process.env.EVALANCHE_SIGNER_KEYSTORE_PASSWORD;
    }
  });

  it('refuses to bind a non-loopback host', async () => {
    const paths = await dirs();
    const verifier = generateEd25519KeyPair();
    await expect(startSignerServer({
      privateKey: TREASURY_KEY,
      verifierPublicKey: verifier.publicKey,
      token: 'test-token',
      auditLogPath: paths.audit,
      nonceStorePath: paths.nonce,
      chainId: CHAIN_ID,
      host: '0.0.0.0',
      port: 0,
      allow: ALLOW,
      initNonces: true,
      allowInsecureFilePermissions: true,
    })).rejects.toThrow(/127\.0\.0\.1/);
  });
});
