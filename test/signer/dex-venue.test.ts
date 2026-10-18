/**
 * Direct swap venues for chains the Kyber plus Li.Fi path cannot serve.
 * Each venue stays off until chains[id].dex.enabled, and the chain stays off
 * until enabled. Moonbeam, Blast, and Scroll cannot be enabled. Sonic and
 * HyperEVM use the Kyber path, so a direct venue is not available.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress, solidityPacked } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import {
  DEX_UNSAFE_REASON,
  DEX_VENUES,
  decodeDexCalldata,
  type DexVenueConfig,
  type PinnedDexVenue,
} from '../../src/signer/dex-venue';
import type { SignerChainConfig } from '../../src/signer/chain-policy';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const OUT = getAddress('0x000000000000000000000000000000000000cafe');
const MID = getAddress('0x000000000000000000000000000000000000b00b');
const STRANGER = getAddress('0x000000000000000000000000000000000000beef');
const ATTACKER = getAddress('0x000000000000000000000000000000000000dead');
const WRONG_ROUTER = getAddress('0x0000000000000000000000000000000000000002');
const CAP = '1000000000000000000000';

const SWAP_ROUTER_02 = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
const SWAP_ROUTER = new Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);
const V2 = new Interface([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

function deadline(seconds = 120): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

interface Leg {
  tokenIn?: string;
  tokenOut?: string;
  recipient?: string;
  amountIn?: bigint;
  minOut?: bigint;
  deadline?: bigint;
}

function swapCall(venue: PinnedDexVenue, patch: Leg = {}): string {
  const tokenIn = patch.tokenIn ?? venue.wrappedNative;
  const tokenOut = patch.tokenOut ?? OUT;
  const recipient = patch.recipient ?? WALLET;
  const amountIn = patch.amountIn ?? 1000n;
  const minOut = patch.minOut ?? 1n;
  const until = patch.deadline ?? deadline();
  if (venue.style === 'uniswap-v2') {
    return V2.encodeFunctionData('swapExactTokensForTokens', [amountIn, minOut, [tokenIn, tokenOut], recipient, until]);
  }
  if (venue.style === 'swap-router') {
    return SWAP_ROUTER.encodeFunctionData('exactInputSingle', [{
      tokenIn,
      tokenOut,
      fee: 500,
      recipient,
      deadline: until,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }]);
  }
  return SWAP_ROUTER_02.encodeFunctionData('exactInputSingle', [{
    tokenIn,
    tokenOut,
    fee: 500,
    recipient,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  }]);
}

/** Calldata the signer is willing to accept for this style. Router02 needs a timed multicall. */
function happyCall(venue: PinnedDexVenue, patch: Leg = {}): string {
  const inner = swapCall(venue, patch);
  if (venue.style !== 'swap-router02') return inner;
  return SWAP_ROUTER_02.encodeFunctionData('multicall(uint256,bytes[])', [patch.deadline ?? deadline(), [inner]]);
}

function badMulticall(venue: PinnedDexVenue): string {
  const good = swapCall(venue);
  const bad = swapCall(venue, { recipient: ATTACKER });
  if (venue.style === 'swap-router02') {
    return SWAP_ROUTER_02.encodeFunctionData('multicall(uint256,bytes[])', [deadline(), [good, bad]]);
  }
  const iface = venue.style === 'uniswap-v2' ? V2 : SWAP_ROUTER;
  return iface.encodeFunctionData('multicall(bytes[])', [[good, bad]]);
}

function avalanche(): SignerChainConfig {
  return {
    gas: { maxFeeUsd: 1 },
    tokenCaps: { native: '0' },
    price: { prices: { native: 1 } },
  };
}

async function boot(
  chains: Record<string, SignerChainConfig>,
  allow: Record<string, Array<Record<string, unknown>>>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dex-'));
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
    allow,
    chains: { 43114: avalanche(), ...chains },
  });
  servers.push(server);
  return { server, verifier };
}

function tokenAllow(addresses: string[], extra: Array<Record<string, unknown>> = []) {
  return [
    ...addresses.map((address) => ({ address, selectors: [] as string[], decimals: 18, roles: ['token'] })),
    ...extra,
  ];
}

function venueDex(venue: PinnedDexVenue, dex?: DexVenueConfig): DexVenueConfig {
  const config = dex ?? { enabled: true };
  if (venue.chainId !== 5000 || config.enabled !== true || dex !== undefined) return config;
  return { ...config, poolDepthVerified: true, verifiedAt: '2026-10-18' };
}

async function bootVenue(
  venue: PinnedDexVenue,
  options: {
    chainEnabled?: boolean;
    dex?: DexVenueConfig;
    tokens?: string[];
    caps?: Record<string, string>;
    extraAllow?: Array<Record<string, unknown>>;
  } = {},
) {
  const tokens = options.tokens ?? [venue.wrappedNative, OUT];
  const caps: Record<string, string> = { native: '0', ...(options.caps ?? {}) };
  for (const token of tokens) caps[getAddress(token)] = caps[getAddress(token)] ?? CAP;
  if (options.caps === undefined) caps[venue.wrappedNative] = CAP;
  return boot(
    {
      [venue.chainId]: {
        enabled: options.chainEnabled ?? true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: caps,
        price: { prices: { native: 1 } },
        dex: venueDex(venue, options.dex),
      },
    },
    {
      43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      [venue.chainId]: tokenAllow(tokens, options.extraAllow),
    },
  );
}

async function send(
  h: Awaited<ReturnType<typeof boot>>,
  venue: PinnedDexVenue,
  data: string,
  nonce: string,
  to = venue.router,
  intentPatch: Partial<SigningIntent> = {},
  value = '0',
) {
  const tx: ApprovedTransaction = {
    to: getAddress(to),
    value,
    data,
    chainId: venue.chainId,
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
    intentId: `dex-${venue.chainId}-${nonce}`,
    nonce,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId: venue.chainId,
    venue: venue.name,
    action: 'swap',
    amountIn: '1000',
    minAmountOut: '1',
    tokenIn: { address: venue.wrappedNative, symbol: 'IN', decimals: 18 },
    tokenOut: { address: OUT, symbol: 'OUT', decimals: 18 },
    routeHash: computeApprovedTxHash(tx),
    tx,
    ...intentPatch,
  };
  const approval = signVerifierApproval({
    intent: built,
    verifierPrivateKey: h.verifier.privateKey,
    verifierPublicKey: h.verifier.publicKey,
  });
  return h.server.handle({
    requestId: `dex-${venue.chainId}-${nonce}`,
    kind: 'transaction',
    chainId: venue.chainId,
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
    intent: 'swap',
    structuredIntent: built,
    approval,
  });
}

for (const venue of DEX_VENUES) {
  describe(venue.name, () => {
    it('signs a treasury swap with a nonzero minOut', async () => {
      const h = await bootVenue(venue);
      const signed = await send(h, venue, happyCall(venue), '1');
      expect(signed.signedTransaction).toMatch(/^0x/);
    });

    it('rejects a recipient that is not the treasury', async () => {
      const h = await bootVenue(venue);
      await expect(send(h, venue, happyCall(venue, { recipient: ATTACKER }), '1')).rejects.toThrow(/treasury/);
    });

    it('rejects a zero amountOutMin', async () => {
      const h = await bootVenue(venue);
      await expect(send(h, venue, happyCall(venue, { minOut: 0n }), '1')).rejects.toThrow(/amountOutMin/);
    });

    it('rejects a path token that is not allowlisted', async () => {
      const h = await bootVenue(venue);
      await expect(send(h, venue, happyCall(venue, { tokenOut: STRANGER }), '1', venue.router, {
        tokenOut: { address: STRANGER, symbol: 'NO', decimals: 18 },
      })).rejects.toThrow(/not allowlisted/);
    });

    it('rejects a router that is not the pin', async () => {
      const h = await bootVenue(venue);
      await expect(send(h, venue, happyCall(venue), '1', WRONG_ROUTER)).rejects.toThrow(/not allowlisted/);
    });

    it('rejects the chain while it is disabled', async () => {
      const h = await bootVenue(venue, { chainEnabled: false });
      await expect(send(h, venue, happyCall(venue), '1')).rejects.toThrow(/not allowed/);
    });

    it('rejects a multicall when an inner recipient is not the treasury', async () => {
      const h = await bootVenue(venue);
      await expect(send(h, venue, badMulticall(venue), '1')).rejects.toThrow(/treasury/);
    });

    it('rejects the pinned router while the venue is off, even if the selector is allowlisted', async () => {
      const data = happyCall(venue);
      const h = await bootVenue(venue, {
        dex: { enabled: false },
        extraAllow: [{ address: venue.router, selectors: [data.slice(0, 10)] }],
      });
      await expect(send(h, venue, data, '1')).rejects.toThrow(/DEX venue is disabled/);
    });
  });
}

describe('SwapRouter02 deadline', () => {
  it('rejects a bare exactInputSingle because that struct has no deadline', async () => {
    const venue = DEX_VENUES.find((item) => item.chainId === 100)!;
    const h = await bootVenue(venue);
    await expect(send(h, venue, swapCall(venue), '1')).rejects.toThrow(/DEX selector/);
  });
});

describe('direct venue startup', () => {
  it('refuses a direct venue on Sonic and HyperEVM', async () => {
    for (const chainId of [146, 999]) {
      await expect(boot({
        [chainId]: {
          enabled: true,
          dex: { enabled: true },
          gas: { maxFeeUsd: 1 },
          tokenCaps: { native: '0' },
          price: { prices: { native: 1 } },
        },
      }, {
        43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      })).rejects.toThrow(/not available/);
    }
  });

  it('refuses dex.enabled on a chain that was assessed as not safe', async () => {
    for (const chainId of Object.keys(DEX_UNSAFE_REASON).map(Number)) {
      await expect(boot({
        [chainId]: {
          enabled: true,
          dex: { enabled: true },
          gas: { maxFeeUsd: 1 },
          tokenCaps: { native: '0' },
          price: { prices: { native: 1 } },
        },
      }, {
        43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      })).rejects.toThrow(/not safe/);
    }
  });

  it('refuses an enabled venue when the pinned wrapped native has no cap', async () => {
    const venue = DEX_VENUES.find((item) => item.chainId === 25)!;
    await expect(boot({
      25: {
        enabled: true,
        dex: { enabled: true },
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0', [OUT]: CAP },
        price: { prices: { native: 1 } },
      },
    }, {
      43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      25: tokenAllow([OUT]),
    })).rejects.toThrow(new RegExp(`missing a cap for ${venue.wrappedNative}`));
  });

  it('refuses a configured router that is not the pin', async () => {
    const venue = DEX_VENUES.find((item) => item.chainId === 25)!;
    await expect(bootVenue(venue, { dex: { enabled: true, router: WRONG_ROUTER } })).rejects.toThrow(/does not match the pinned router/);
  });
});

describe('Mantle pool depth acknowledgement', () => {
  const venue = DEX_VENUES.find((item) => item.chainId === 5000)!;

  function mantleChain(dex: DexVenueConfig): Record<string, SignerChainConfig> {
    return {
      5000: {
        enabled: true,
        dex,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0', [venue.wrappedNative]: CAP, [OUT]: CAP },
        price: { prices: { native: 1 } },
      },
    };
  }

  function mantleAllow() {
    return {
      43114: [{ address: ATTACKER, selectors: ['0x'], roles: ['recipient'] }],
      5000: tokenAllow([venue.wrappedNative, OUT]),
    };
  }

  it('refuses dex.enabled until pool depth is rechecked', async () => {
    await expect(boot(mantleChain({ enabled: true }), mantleAllow())).rejects.toThrow(/pool depth must be rechecked/);
    await expect(boot(mantleChain({ enabled: true, poolDepthVerified: false, verifiedAt: '2026-10-18' }), mantleAllow())).rejects.toThrow(/pool depth must be rechecked/);
    await expect(boot(mantleChain({ enabled: true, poolDepthVerified: true }), mantleAllow())).rejects.toThrow(/pool depth must be rechecked/);
    await expect(boot(mantleChain({ enabled: true, poolDepthVerified: true, verifiedAt: '2026-13-40' }), mantleAllow())).rejects.toThrow(/verifiedAt/);
    await expect(boot(mantleChain({ enabled: true, poolDepthVerified: true, verifiedAt: '2099-01-01' }), mantleAllow())).rejects.toThrow(/verifiedAt/);
  });

  it('starts and signs once poolDepthVerified and verifiedAt are set', async () => {
    const h = await boot(mantleChain({ enabled: true, poolDepthVerified: true, verifiedAt: '2026-10-18' }), mantleAllow());
    const signed = await send(h, venue, happyCall(venue), '1');
    expect(signed.signedTransaction).toMatch(/^0x/);
  });

  it('does not require the acknowledgement while the Mantle venue is off', async () => {
    const h = await boot(mantleChain({ enabled: false }), mantleAllow());
    expect(h.server).toBeDefined();
  });
});

describe('packed path', () => {
  it('accepts three allowlisted tokens and rejects a middle token that is not', () => {
    const venue = DEX_VENUES.find((item) => item.style === 'swap-router')!;
    const nowSec = Math.floor(Date.now() / 1000);
    const input = {
      chainId: venue.chainId,
      config: { enabled: true } satisfies DexVenueConfig,
      wallet: WALLET,
      value: 0n,
      tokenIn: venue.wrappedNative,
      tokenOut: OUT,
      amountIn: 1000n,
      nowSec,
      allowRole: (address: string) => [venue.wrappedNative, OUT, MID].includes(getAddress(address)),
    };
    const good = solidityPacked(
      ['address', 'uint24', 'address', 'uint24', 'address'],
      [venue.wrappedNative, 500, MID, 500, OUT],
    );
    const data = SWAP_ROUTER.encodeFunctionData('exactInput', [{
      path: good,
      recipient: WALLET,
      deadline: deadline(),
      amountIn: 1000n,
      amountOutMinimum: 1n,
    }]);
    const decoded = decodeDexCalldata(venue.router, data, input);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.tokenIn).toBe(venue.wrappedNative);
    expect(decoded[0]?.tokenOut).toBe(OUT);

    const badPath = solidityPacked(
      ['address', 'uint24', 'address', 'uint24', 'address'],
      [venue.wrappedNative, 500, STRANGER, 500, OUT],
    );
    const bad = SWAP_ROUTER.encodeFunctionData('exactInput', [{
      path: badPath,
      recipient: WALLET,
      deadline: deadline(),
      amountIn: 1000n,
      amountOutMinimum: 1n,
    }]);
    expect(() => decodeDexCalldata(venue.router, bad, input)).toThrow(/not allowlisted/);
  });
});
