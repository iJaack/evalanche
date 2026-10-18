/**
 * Uniswap v3 CLMM on Avalanche. Disabled unless chains[43114].clmm.enabled.
 * Mint, collect, decrease, and burn are allowlisted. NFT transfer and
 * approval selectors stay blocked. Multicall fails closed on one bad inner.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, MaxUint256, Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import {
  AVALANCHE_UNISWAP_V3_NPM,
  AVALANCHE_USDC,
  AVALANCHE_WAVAX,
  AVALANCHE_WAVAX_USDC_POOL,
  decodeClmmCalldata,
  type ClmmModuleConfig,
} from '../../src/signer/clmm';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const NPM = new Interface([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable',
  'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable',
  'function approve(address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
]);
const ERC20 = new Interface(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']);
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function poolConfig(extra: Partial<ClmmModuleConfig> = {}): ClmmModuleConfig {
  return {
    enabled: true,
    pools: [{
      pool: AVALANCHE_WAVAX_USDC_POOL,
      token0: AVALANCHE_WAVAX,
      token1: AVALANCHE_USDC,
      fee: 500,
      tickSpacing: 10,
      tickLowerMin: -200,
      tickLowerMax: 0,
      tickUpperMin: 10,
      tickUpperMax: 200,
      amount0Cap: '1000000000000000000',
      amount1Cap: '1000000',
    }],
    ...extra,
  };
}

function deadline(seconds = 120): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

function mintData(patch: Record<string, unknown> = {}): string {
  return NPM.encodeFunctionData('mint', [{
    token0: AVALANCHE_WAVAX,
    token1: AVALANCHE_USDC,
    fee: 500,
    tickLower: -100,
    tickUpper: 100,
    amount0Desired: 1000n,
    amount1Desired: 1000n,
    amount0Min: 1n,
    amount1Min: 1n,
    recipient: WALLET,
    deadline: deadline(),
    ...patch,
  }]);
}

function owned(ids = ['42']): SigningIntent {
  return { clmm: { ownedTokenIds: ids } } as SigningIntent;
}

function decode(to: string, data: string, cfg: ClmmModuleConfig | undefined = poolConfig(), value = 0n, intent?: SigningIntent) {
  return decodeClmmCalldata(to, data, cfg, WALLET, value, Math.floor(Date.now() / 1000), intent);
}

describe('CLMM calldata gates', () => {
  it('allows an exact approve, mint, collect, decrease, and burn', () => {
    const approve = decode(AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 1000n]));
    expect(approve[0]?.op).toBe('approve');
    expect(decode(AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 0n]))[0]?.amount).toBe(0n);
    expect(decode(AVALANCHE_WAVAX, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 1000n]))[0]?.op).toBe('approve');
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, mintData())[0]?.op).toBe('mint');
    const collect = NPM.encodeFunctionData('collect', [{ tokenId: 42n, recipient: WALLET, amount0Max: 1n, amount1Max: 0n }]);
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, collect, poolConfig(), 0n, owned())[0]?.op).toBe('collect');
    const decrease = NPM.encodeFunctionData('decreaseLiquidity', [{
      tokenId: 42n, liquidity: 10n, amount0Min: 1n, amount1Min: 0n, deadline: deadline(),
    }]);
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, decrease, poolConfig(), 0n, owned())[0]?.op).toBe('decrease');
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, NPM.encodeFunctionData('burn', [42n]), poolConfig(), 0n, owned())[0]?.op).toBe('burn');
  });

  it('blocks NFT transfer and approval, and increaseLiquidity unless enabled', () => {
    const blocked: Array<[string, string]> = [
      ['approve', NPM.encodeFunctionData('approve', [ATTACKER, 1n])],
      ['setApprovalForAll', NPM.encodeFunctionData('setApprovalForAll', [ATTACKER, true])],
      ['transferFrom', NPM.encodeFunctionData('transferFrom', [WALLET, ATTACKER, 1n])],
      ['safeTransferFrom', NPM.encodeFunctionData('safeTransferFrom(address,address,uint256)', [WALLET, ATTACKER, 1n])],
      ['safeTransferFrom bytes', NPM.encodeFunctionData('safeTransferFrom(address,address,uint256,bytes)', [WALLET, ATTACKER, 1n, '0x'])],
    ];
    for (const [label, data] of blocked) {
      expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, data), label).toThrow(/NFT/);
    }
    const increase = NPM.encodeFunctionData('increaseLiquidity', [{
      tokenId: 42n, amount0Desired: 10n, amount1Desired: 10n, amount0Min: 1n, amount1Min: 1n, deadline: deadline(),
    }]);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, increase, poolConfig(), 0n, owned())).toThrow(/increaseLiquidity is disabled/);
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, increase, poolConfig({ increaseLiquidity: true }), 0n, owned())[0]?.op).toBe('increase');
  });

  it('rejects a multicall when any inner call fails', () => {
    const good = NPM.encodeFunctionData('multicall', [[mintData()]]);
    expect(decode(AVALANCHE_UNISWAP_V3_NPM, good).map((call) => call.op)).toEqual(['mint']);
    const bad = NPM.encodeFunctionData('multicall', [[
      mintData(),
      NPM.encodeFunctionData('transferFrom', [WALLET, ATTACKER, 1n]),
    ]]);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, bad)).toThrow(/transferFrom/);
  });

  it('rejects deadline, ticks, recipient, amountMin, cap, value, and an unowned token id', () => {
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ deadline: deadline(601) }))).toThrow(/10 minutes/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ tickLower: -15 }))).toThrow(/spacing|bounds/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ recipient: ATTACKER }))).toThrow(/recipient/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ amount0Min: 0n }))).toThrow(/amount0Min/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ amount0Desired: 10n ** 18n + 1n }))).toThrow(/cap/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData(), poolConfig(), 1n)).toThrow(/value must be 0/);
    const collectAttacker = NPM.encodeFunctionData('collect', [{ tokenId: 42n, recipient: ATTACKER, amount0Max: 1n, amount1Max: 1n }]);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, collectAttacker, poolConfig(), 0n, owned())).toThrow(/collect recipient/);
    const bothZero = NPM.encodeFunctionData('decreaseLiquidity', [{
      tokenId: 42n, liquidity: 10n, amount0Min: 0n, amount1Min: 0n, deadline: deadline(),
    }]);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, bothZero, poolConfig(), 0n, owned())).toThrow(/amountMin/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, NPM.encodeFunctionData('burn', [99n]), poolConfig(), 0n, owned())).toThrow(/treasury-owned/);
    expect(() => decode(AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, MaxUint256]))).toThrow(/Unlimited/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData(), { enabled: false })).toThrow(/disabled/);
    expect(() => decode(AVALANCHE_UNISWAP_V3_NPM, mintData({ token0: AVALANCHE_USDC, token1: AVALANCHE_WAVAX }))).toThrow(/not allowlisted|sort/);
  });
});

describe('CLMM signer path', () => {
  async function boot(clmm: ClmmModuleConfig | undefined, allowOverride?: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'clmm-'));
    const verifier = generateEd25519KeyPair();
    const server = await startSignerServer({
      privateKey: KEY,
      verifierPublicKey: verifier.publicKey,
      token: 't',
      auditLogPath: join(root, 'a.jsonl'),
      nonceStorePath: join(root, 'n.json'),
      initNonces: true,
      allowInsecureFilePermissions: true,
      port: 0,
      simulate: async () => ({ success: true }),
      allow: allowOverride ?? {
        43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      },
      chains: {
        43114: {
          gas: { maxFeeUsd: 1 },
          tokenCaps: {
            native: '0',
            ...(clmm ? {
              [getAddress(AVALANCHE_USDC)]: '1000000000000',
              [getAddress(AVALANCHE_WAVAX)]: '1000000000000000000000',
            } : {}),
          },
          price: { prices: { native: 20 } },
          ...(clmm ? { clmm } : {}),
        },
      },
    });
    servers.push(server);
    return { server, verifier, root };
  }

  async function send(
    h: Awaited<ReturnType<typeof boot>>,
    to: string,
    data: string,
    nonce: string,
    extra: Partial<SigningIntent> = {},
    value = '0',
  ) {
    const tx: ApprovedTransaction = {
      to: getAddress(to),
      value,
      data,
      chainId: 43114,
      nonce: '0',
      gasLimit: '400000',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      gasPrice: '1',
      type: 0,
    };
    const now = Date.now();
    const built: SigningIntent = {
      version: '1',
      intentId: `clmm-${nonce}`,
      nonce,
      createdAt: now,
      expiresAt: now + 60_000,
      wallet: WALLET,
      chainId: 43114,
      venue: 'uniswap-v3',
      action: 'clmm',
      routeHash: computeApprovedTxHash(tx),
      tx,
      ...extra,
    };
    const approval = signVerifierApproval({
      intent: built,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
    });
    return h.server.handle({
      requestId: `clmm-${nonce}`,
      kind: 'transaction',
      chainId: 43114,
      from: WALLET,
      to: getAddress(to),
      value,
      data,
      gasLimit: '400000',
      gasPrice: '1',
      maxFeePerGas: '0',
      maxPriorityFeePerGas: '0',
      nonce: 0,
      type: 0,
      intent: 'clmm',
      structuredIntent: built,
      approval,
    });
  }

  it('signs mint and an exact USDC approve only when the module is enabled', async () => {
    const on = await boot(poolConfig());
    const minted = await send(on, AVALANCHE_UNISWAP_V3_NPM, mintData(), '1');
    expect(minted.signedTransaction).toMatch(/^0x/);
    const approved = await send(on, AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 1000n]), '2');
    expect(approved.signedTransaction).toMatch(/^0x/);

    const off = await boot(undefined);
    await expect(send(off, AVALANCHE_UNISWAP_V3_NPM, mintData(), '1')).rejects.toThrow(/not allowlisted/);
    await expect(send(off, AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 1000n]), '1')).rejects.toThrow(/not allowlisted/);
    const zero = await send(on, AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 0n]), '3');
    expect(zero.signedTransaction).toMatch(/^0x/);
  });

  it('does not inject a transfer selector, and still honours one the operator configured', async () => {
    const on = await boot(poolConfig());
    const data = ERC20.encodeFunctionData('transfer', [ATTACKER, 1n]);
    await expect(send(on, AVALANCHE_USDC, data, '1', {
      action: 'transfer',
      amountIn: '1',
      tokenIn: { address: AVALANCHE_USDC, symbol: 'USDC', decimals: 6 },
    })).rejects.toThrow(/not allowlisted/);
    const approved = await send(on, AVALANCHE_USDC, ERC20.encodeFunctionData('approve', [AVALANCHE_UNISWAP_V3_NPM, 1000n]), '2');
    expect(approved.signedTransaction).toMatch(/^0x/);

    const configured = await boot(poolConfig(), {
      43114: [
        { address: ATTACKER, selectors: ['0x'], roles: ['recipient'] },
        { address: AVALANCHE_USDC, selectors: ['0xa9059cbb'], decimals: 6, roles: ['token'] },
      ],
    });
    const moved = await send(configured, AVALANCHE_USDC, data, '1', {
      action: 'transfer',
      amountIn: '1',
      tokenIn: { address: AVALANCHE_USDC, symbol: 'USDC', decimals: 6 },
    });
    expect(moved.signedTransaction).toMatch(/^0x/);
  });

  it('denies the position manager while CLMM is off even when the allow map names it', async () => {
    const selector = mintData().slice(0, 10);
    const off = await boot(undefined, {
      43114: [
        { address: ATTACKER, selectors: ['0x'], roles: ['recipient'] },
        { address: AVALANCHE_UNISWAP_V3_NPM, selectors: [selector] },
      ],
    });
    await expect(send(off, AVALANCHE_UNISWAP_V3_NPM, mintData(), '1')).rejects.toThrow(/CLMM module is disabled/);
  });

  it('rejects a multicall that collects to a non-treasury recipient', async () => {
    const h = await boot(poolConfig());
    const bad = NPM.encodeFunctionData('multicall', [[
      NPM.encodeFunctionData('collect', [{ tokenId: 42n, recipient: ATTACKER, amount0Max: 1n, amount1Max: 1n }]),
    ]]);
    await expect(send(h, AVALANCHE_UNISWAP_V3_NPM, bad, '1', { clmm: { ownedTokenIds: ['42'] } })).rejects.toThrow(/collect recipient/);
  });

  it('blocks a multicall that hides transferFrom and blocks increaseLiquidity', async () => {
    const h = await boot(poolConfig());
    const bad = NPM.encodeFunctionData('multicall', [[
      mintData(),
      NPM.encodeFunctionData('transferFrom', [WALLET, ATTACKER, 1n]),
    ]]);
    await expect(send(h, AVALANCHE_UNISWAP_V3_NPM, bad, '1')).rejects.toThrow(/transferFrom/);
    const increase = NPM.encodeFunctionData('increaseLiquidity', [{
      tokenId: 42n, amount0Desired: 10n, amount1Desired: 10n, amount0Min: 1n, amount1Min: 1n, deadline: deadline(),
    }]);
    await expect(send(h, AVALANCHE_UNISWAP_V3_NPM, increase, '2', { clmm: { ownedTokenIds: ['42'] } })).rejects.toThrow(/increaseLiquidity is disabled/);
  });
});
