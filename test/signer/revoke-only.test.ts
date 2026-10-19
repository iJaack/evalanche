/**
 * Revoke-only is off until chains[id].revokeOnly.enabled is true.
 * A zero approve to any spender, and setApprovalForAll(operator, false),
 * are then accepted for an allowlisted or known token. Everything else
 * on that path is denied.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, Wallet, getAddress } from 'ethers';
import { generateEd25519KeyPair, startSignerServer } from '../../src/index';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import { PM_PUSD } from '../../src/signer/polymarket-addresses';
import {
  POLYGON_NATIVE_USDC,
  POLYGON_USDC_E,
  type RevokeOnlyConfig,
} from '../../src/signer/revoke-only';
import type { EvalancheSignerServer } from '../../src/signer/server';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const NO_CODE = '0x794a61358d6845594f3DCa32f21763fB5b21AbDf';
const NFT = '0x000000000000000000000000000000000000bEEF';
const SPEND = '0x0000000000000000000000000000000000000002';
const LISTED = '0x0000000000000000000000000000000000000001';
const STRANGER = '0x0000000000000000000000000000000000000abc';

const ERC20 = new Interface([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);
const ERC1155 = new Interface(['function setApprovalForAll(address operator, bool approved)']);

const servers: EvalancheSignerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

async function boot(
  revokeOnly?: RevokeOnlyConfig | Record<string, unknown>,
  explicitAllows?: Array<'permit' | 'permit2' | 'increaseAllowance'>,
) {
  const root = await mkdtemp(join(tmpdir(), 'revoke-only-'));
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
    explicitAllows,
    allow: {
      43114: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      137: [
        { address: WALLET, selectors: ['0x'], roles: ['recipient'] },
        { address: NFT, selectors: [], decimals: 18, roles: ['token'] },
        { address: LISTED, selectors: ['0x095ea7b3'], decimals: 6, roles: ['token'] },
        { address: SPEND, selectors: [], decimals: 18, roles: ['spender'] },
      ],
    },
    chains: {
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 1 } },
      },
      137: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: {
          native: '1000000000000000000',
          [getAddress(NFT)]: '1000',
          [getAddress(LISTED)]: '1000',
        },
        price: { prices: { native: 1 } },
        revokeOnly: revokeOnly as RevokeOnlyConfig | undefined,
      },
    },
  });
  servers.push(server);
  return { server, verifier };
}

function tx(to: string, data: string, value = '0'): ApprovedTransaction {
  return {
    to: getAddress(to),
    value,
    data,
    chainId: 137,
    nonce: '0',
    gasLimit: '100000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
}

async function submit(
  h: Awaited<ReturnType<typeof boot>>,
  to: string,
  data: string,
  amountIn: string,
  nonce = '1',
  value = '0',
) {
  const approved = tx(to, data, value);
  const now = Date.now();
  const intent: SigningIntent = {
    version: '1',
    intentId: `revoke-${nonce}`,
    nonce,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId: 137,
    venue: 'spot',
    action: 'approve',
    amountIn,
    tokenIn: { address: getAddress(to), symbol: 'T', decimals: 6 },
    routeHash: computeApprovedTxHash(approved),
    tx: approved,
  };
  return h.server.handle({
    requestId: intent.intentId,
    kind: 'transaction',
    chainId: 137,
    from: WALLET,
    to: approved.to,
    value,
    data,
    gasLimit: '100000',
    gasPrice: '1',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'approve',
    structuredIntent: intent,
    approval: signVerifierApproval({
      intent,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
    }),
  });
}

describe('revoke-only', () => {
  it('accepts a zero approve of known Polygon USDC to the no-code spender and denies the rest', async () => {
    const h = await boot({ enabled: true });
    const zeroE = ERC20.encodeFunctionData('approve', [NO_CODE, 0n]);
    const zeroNative = ERC20.encodeFunctionData('approve', [NO_CODE, 0n]);
    const signed = await submit(h, POLYGON_USDC_E, zeroE, '0');
    expect(signed.signedTransaction).toMatch(/^0x/);
    const native = await submit(h, POLYGON_NATIVE_USDC, zeroNative, '0', '2');
    expect(native.signedTransaction).toMatch(/^0x/);

    const clear = ERC1155.encodeFunctionData('setApprovalForAll', [NO_CODE, false]);
    const nft = await submit(h, NFT, clear, '0', '3');
    expect(nft.signedTransaction).toMatch(/^0x/);

    const exact = ERC20.encodeFunctionData('approve', [SPEND, 5n]);
    const kept = await submit(h, LISTED, exact, '5', '4');
    expect(kept.signedTransaction).toMatch(/^0x/);

    await expect(submit(h, POLYGON_USDC_E, ERC20.encodeFunctionData('approve', [NO_CODE, 1n]), '1', '5')).rejects.toThrow(/zero amount/);
    await expect(submit(h, POLYGON_NATIVE_USDC, ERC20.encodeFunctionData('approve', [NO_CODE, 48n]), '48', '6')).rejects.toThrow(/zero amount/);
    await expect(submit(h, NFT, ERC1155.encodeFunctionData('setApprovalForAll', [NO_CODE, true]), '0', '7')).rejects.toThrow(/operator, true/);
    await expect(submit(h, POLYGON_USDC_E, ERC20.encodeFunctionData('increaseAllowance', [NO_CODE, 1n]), '1', '8')).rejects.toThrow(/increaseAllowance/);
    await expect(submit(h, POLYGON_USDC_E, ERC20.encodeFunctionData('permit', [
      WALLET, NO_CODE, 1n, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
    ]), '1', '9')).rejects.toThrow(/permit/);
    await expect(submit(h, POLYGON_USDC_E, zeroE, '0', '10', '1')).rejects.toThrow(/value must be 0/);
    await expect(submit(h, POLYGON_USDC_E, `${zeroE}00`, '0', '11')).rejects.toThrow(/trailing/);
    await expect(submit(h, STRANGER, zeroE, '0', '12')).rejects.toThrow(/not allowlisted/);
    await expect(submit(h, PM_PUSD, zeroE, '0', '13')).rejects.toThrow(/Polymarket denial/);
  });

  it('stays off when the flag is omitted or false', async () => {
    const off = await boot();
    const data = ERC20.encodeFunctionData('approve', [NO_CODE, 0n]);
    await expect(submit(off, POLYGON_USDC_E, data, '0')).rejects.toThrow(/not allowlisted/);
    await off.server.close();
    const explicit = await boot({ enabled: false });
    await expect(submit(explicit, POLYGON_NATIVE_USDC, data, '0')).rejects.toThrow(/not allowlisted/);
  });

  it('still denies permit when the explicit permit allow is on', async () => {
    const h = await boot({ enabled: true }, ['permit', 'increaseAllowance']);
    const data = ERC20.encodeFunctionData('permit', [
      WALLET, NO_CODE, 1n, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`,
    ]);
    await expect(submit(h, POLYGON_USDC_E, data, '1')).rejects.toThrow(/revoke-only denies permit/);
  });

  it('fails startup on a bad revokeOnly config', async () => {
    await expect(boot({ enabled: 'yes' })).rejects.toThrow(/enabled must be a boolean/);
    await expect(boot({ enabled: true, tokens: [POLYGON_USDC_E] })).rejects.toThrow(/not a revoke-only setting/);
  });
});
