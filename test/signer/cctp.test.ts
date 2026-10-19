/**
 * CCTP V2 is off until chains[id].cctp.enabled is true.
 * Avalanche may burn native USDC to a listed domain, with the mint
 * recipient equal to the treasury, and may approve the messenger for the
 * exact amount. Polygon may receive a standard, fee-free message whose
 * burn-body mint recipient is the treasury.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Interface, MaxUint256, Wallet, getAddress } from 'ethers';
import {
  buildCctpApprove,
  buildCctpBurn,
  buildCctpMint,
  generateEd25519KeyPair,
  startSignerServer,
} from '../../src/index';
import {
  CCTP_MESSAGE_TRANSMITTER_V2,
  CCTP_STANDARD_FINALITY,
  CCTP_TOKEN_MESSENGER_V2,
  CCTP_TOKEN_MINTER_V2,
  takeCctp,
  type CctpConfig,
} from '../../src/signer/cctp';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import { AVALANCHE_NATIVE_USDC, POLYGON_NATIVE_USDC } from '../../src/signer/revoke-only';
import type { EvalancheSignerServer } from '../../src/signer/server';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const WALLET = new Wallet(KEY).address;
const OTHER = getAddress('0x00000000000000000000000000000000000000ab');
const MESSENGER = getAddress(CCTP_TOKEN_MESSENGER_V2);
const TRANSMITTER = getAddress(CCTP_MESSAGE_TRANSMITTER_V2);
const MINTER = getAddress(CCTP_TOKEN_MINTER_V2);
const AVAX_USDC = getAddress(AVALANCHE_NATIVE_USDC);
const POLY_USDC = getAddress(POLYGON_NATIVE_USDC);
const AMOUNT = 1_000_000n;

const MESSENGER_IFACE = new Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)',
]);
const TRANSMITTER_IFACE = new Interface(['function receiveMessage(bytes message, bytes attestation)']);
const ERC20 = new Interface(['function approve(address spender, uint256 amount)']);

const servers: EvalancheSignerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function word(address: string): string {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, '0')}`;
}

function burn(patch: Partial<{
  amount: bigint;
  domain: number;
  mint: string;
  token: string;
  caller: string;
  maxFee: bigint;
  finality: number;
}> = {}): string {
  return MESSENGER_IFACE.encodeFunctionData('depositForBurn', [
    patch.amount ?? AMOUNT,
    patch.domain ?? 7,
    word(patch.mint ?? WALLET),
    patch.token ?? AVAX_USDC,
    word(patch.caller ?? '0x0000000000000000000000000000000000000000'),
    patch.maxFee ?? 0n,
    patch.finality ?? CCTP_STANDARD_FINALITY,
  ]);
}

function message(patch: Partial<{
  source: number;
  dest: number;
  sender: string;
  recipient: string;
  caller: string;
  minFinality: number;
  executed: number;
  burnToken: string;
  mint: string;
  amount: bigint;
  callerOfBurn: string;
  maxFee: bigint;
  fee: bigint;
  expiration: bigint;
  hook: string;
}> = {}): string {
  const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
  const u256 = (n: bigint) => n.toString(16).padStart(64, '0');
  const addr = (value: string) => getAddress(value).slice(2).toLowerCase().padStart(64, '0');
  const header = [
    hex(1, 8),
    hex(patch.source ?? 1, 8),
    hex(patch.dest ?? 7, 8),
    u256(1n),
    addr(patch.sender ?? MESSENGER),
    addr(patch.recipient ?? MESSENGER),
    addr(patch.caller ?? '0x0000000000000000000000000000000000000000'),
    hex(patch.minFinality ?? CCTP_STANDARD_FINALITY, 8),
    hex(patch.executed ?? CCTP_STANDARD_FINALITY, 8),
  ].join('');
  const body = [
    hex(1, 8),
    addr(patch.burnToken ?? AVAX_USDC),
    addr(patch.mint ?? WALLET),
    u256(patch.amount ?? AMOUNT),
    addr(patch.callerOfBurn ?? WALLET),
    u256(patch.maxFee ?? 0n),
    u256(patch.fee ?? 0n),
    u256(patch.expiration ?? 0n),
    patch.hook ?? '',
  ].join('');
  return `0x${header}${body}`;
}

function receive(body = message(), attestation = `0x${'ab'.repeat(32)}`): string {
  return TRANSMITTER_IFACE.encodeFunctionData('receiveMessage', [body, attestation]);
}

const avaxCctp: CctpConfig = {
  enabled: true,
  destinationDomains: [7],
  minFinalityThreshold: CCTP_STANDARD_FINALITY,
};

const polyCctp: CctpConfig = {
  enabled: true,
  sourceDomains: [1],
  minFinalityThreshold: CCTP_STANDARD_FINALITY,
};

async function boot(chains: Record<string, unknown> = {
  43114: {
    gas: { maxFeeUsd: 1 },
    tokenCaps: { native: '0', [AVAX_USDC]: '1000000' },
    price: { prices: { native: 1 } },
    cctp: avaxCctp,
  },
  137: {
    enabled: true,
    gas: { maxFeeUsd: 1 },
    tokenCaps: { native: '1000000000000000000', [POLY_USDC]: '1000000' },
    price: { prices: { native: 1 } },
    cctp: polyCctp,
  },
}) {
  const root = await mkdtemp(join(tmpdir(), 'cctp-'));
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
    allow: {
      43114: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      137: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
    },
    chains: chains as never,
  });
  servers.push(server);
  return { server, verifier };
}

function tx(chainId: number, to: string, data: string, value = '0'): ApprovedTransaction {
  return {
    to: getAddress(to),
    value,
    data,
    chainId,
    nonce: '0',
    gasLimit: '300000',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    gasPrice: '1',
    type: 0,
  };
}

async function submit(
  h: Awaited<ReturnType<typeof boot>>,
  chainId: number,
  to: string,
  data: string,
  patch: Partial<SigningIntent> & { nonce: string },
  value = '0',
) {
  const approved = tx(chainId, to, data, value);
  const now = Date.now();
  const intent: SigningIntent = {
    version: '1',
    intentId: `cctp-${patch.nonce}`,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId,
    venue: 'cctp',
    action: 'cctp-burn',
    amountIn: AMOUNT.toString(),
    tokenIn: { address: chainId === 137 ? POLY_USDC : AVAX_USDC, symbol: 'USDC', decimals: 6 },
    routeHash: computeApprovedTxHash(approved),
    tx: approved,
    ...patch,
  };
  return h.server.handle({
    requestId: intent.intentId,
    kind: 'transaction',
    chainId,
    from: WALLET,
    to: approved.to,
    value,
    data,
    gasLimit: '300000',
    gasPrice: '1',
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: intent.action,
    structuredIntent: intent,
    approval: signVerifierApproval({
      intent,
      verifierPrivateKey: h.verifier.privateKey,
      verifierPublicKey: h.verifier.publicKey,
    }),
  });
}

describe('CCTP V2', () => {
  it('burns Avalanche USDC to Polygon and receives it only for the treasury', async () => {
    const h = await boot();
    const burned = await submit(h, 43114, MESSENGER, burn(), { nonce: '1' });
    expect(burned.signedTransaction).toMatch(/^0x/);
    const approved = ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]);
    const allowance = await submit(h, 43114, AVAX_USDC, approved, { nonce: '2', action: 'cctp-approve' });
    expect(allowance.signedTransaction).toMatch(/^0x/);
    const minted = await submit(h, 137, TRANSMITTER, receive(), { nonce: '3', action: 'cctp-mint' });
    expect(minted.signedTransaction).toMatch(/^0x/);
  });

  it('denies every burn that is not the pinned standard transfer', async () => {
    const h = await boot();
    await expect(submit(h, 43114, MESSENGER, burn({ domain: 0 }), { nonce: '1' })).rejects.toThrow(/destination domain/);
    await expect(submit(h, 43114, MESSENGER, burn({ mint: OTHER }), { nonce: '2' })).rejects.toThrow(/mint recipient/);
    await expect(submit(h, 43114, MESSENGER, burn({ token: POLY_USDC }), { nonce: '3' })).rejects.toThrow(/Avalanche native USDC/);
    await expect(submit(h, 43114, MESSENGER, burn({ caller: OTHER }), { nonce: '4' })).rejects.toThrow(/destinationCaller/);
    await expect(submit(h, 43114, MESSENGER, burn({ maxFee: 1n }), { nonce: '5' })).rejects.toThrow(/maxFee/);
    await expect(submit(h, 43114, MESSENGER, burn({ finality: 1000 }), { nonce: '6' })).rejects.toThrow(/2000/);
    await expect(submit(h, 43114, MESSENGER, burn({ amount: 0n }), { nonce: '7', amountIn: '0' })).rejects.toThrow(/greater than zero/);
    await expect(submit(h, 43114, MESSENGER, burn({ amount: AMOUNT + 1n }), { nonce: '8', amountIn: (AMOUNT + 1n).toString() })).rejects.toThrow(/per-transaction cap/);
    await expect(submit(h, 43114, MESSENGER, `${burn()}00`, { nonce: '9' })).rejects.toThrow(/trailing/);
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '10' }, '1')).rejects.toThrow(/value must be 0/);
    const hooked = MESSENGER_IFACE.encodeFunctionData('depositForBurnWithHook', [
      AMOUNT, 7, word(WALLET), AVAX_USDC, word('0x0000000000000000000000000000000000000000'), 0n, CCTP_STANDARD_FINALITY, '0x',
    ]);
    await expect(submit(h, 43114, MESSENGER, hooked, { nonce: '11' })).rejects.toThrow(/not depositForBurn/);
    await expect(submit(h, 137, MESSENGER, burn(), { nonce: '12' })).rejects.toThrow(/only signed on Avalanche/);
  });

  it('denies an unlimited or unrelated approval and still allows a zero revoke', async () => {
    const h = await boot({
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0', [AVAX_USDC]: '1000000' },
        price: { prices: { native: 1 } },
        cctp: avaxCctp,
        revokeOnly: { enabled: true },
      },
      137: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 1 } },
      },
    });
    const unlimited = ERC20.encodeFunctionData('approve', [MESSENGER, MaxUint256]);
    await expect(submit(h, 43114, AVAX_USDC, unlimited, { nonce: '1', action: 'approve', amountIn: MaxUint256.toString() })).rejects.toThrow(/exact burn amount/);
    const stranger = ERC20.encodeFunctionData('approve', [OTHER, AMOUNT]);
    await expect(submit(h, 43114, AVAX_USDC, stranger, { nonce: '2', action: 'approve' })).rejects.toThrow(/zero amount/);
    const zero = ERC20.encodeFunctionData('approve', [MESSENGER, 0n]);
    const cleared = await submit(h, 43114, AVAX_USDC, zero, { nonce: '3', venue: 'revoke', action: 'revoke', amountIn: '0' });
    expect(cleared.signedTransaction).toMatch(/^0x/);
  });

  it('denies a receive that would mint to anyone but the treasury', async () => {
    const h = await boot();
    await expect(submit(h, 137, TRANSMITTER, receive(message({ mint: OTHER })), { nonce: '1', action: 'receive' })).rejects.toThrow(/mint recipient/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ recipient: MINTER })), { nonce: '2', action: 'cctp-mint' })).rejects.toThrow(/recipient is not TokenMessengerV2/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ sender: MINTER })), { nonce: '13', action: 'cctp-mint' })).rejects.toThrow(/sender is not TokenMessengerV2/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ source: 0 })), { nonce: '3', action: 'cctp-mint' })).rejects.toThrow(/source domain/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ dest: 1 })), { nonce: '4', action: 'cctp-mint' })).rejects.toThrow(/destination domain is not this chain/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ burnToken: POLY_USDC })), { nonce: '5', action: 'cctp-mint' })).rejects.toThrow(/pinned USDC/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ minFinality: 1000, executed: 1000 })), { nonce: '6', action: 'cctp-mint' })).rejects.toThrow(/finality/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ hook: '00' })), { nonce: '7', action: 'cctp-mint' })).rejects.toThrow(/hook data/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ fee: 1n })), { nonce: '8', action: 'cctp-mint' })).rejects.toThrow(/fee/);
    await expect(submit(h, 137, TRANSMITTER, receive(message({ expiration: 1n })), { nonce: '9', action: 'cctp-mint' })).rejects.toThrow(/expiration/);
    await expect(submit(h, 137, TRANSMITTER, receive(message().slice(0, 20)), { nonce: '10', action: 'cctp-mint' })).rejects.toThrow(/too short|could not be decoded/);
    await expect(submit(h, 137, TRANSMITTER, receive(message(), '0x'), { nonce: '11', action: 'cctp-mint' })).rejects.toThrow(/attestation is empty/);
    await expect(submit(h, 43114, TRANSMITTER, receive(), { nonce: '12', action: 'cctp-mint' })).rejects.toThrow(/not this chain/);
  });

  it('stays off until enabled and fails closed on a bad config', async () => {
    const off = await boot({
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0' },
        price: { prices: { native: 1 } },
      },
    });
    await expect(submit(off, 43114, MESSENGER, burn(), { nonce: '1' })).rejects.toThrow(/not allowlisted/);
    await off.server.close();

    const base = {
      gas: { maxFeeUsd: 1 },
      tokenCaps: { native: '0', [AVAX_USDC]: '1000000' },
      price: { prices: { native: 1 } },
    };
    await expect(boot({ 43114: { ...base, cctp: { enabled: 'yes' } } })).rejects.toThrow(/enabled must be a boolean/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, messenger: MESSENGER } } })).rejects.toThrow(/not a CCTP setting/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, destinationDomains: [7] } } })).rejects.toThrow(/minFinalityThreshold must be 2000/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, destinationDomains: [7], minFinalityThreshold: 1000 } } })).rejects.toThrow(/must be 2000/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, destinationDomains: [4], minFinalityThreshold: 2000 } } })).rejects.toThrow(/not a Circle domain/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, destinationDomains: [1], minFinalityThreshold: 2000 } } })).rejects.toThrow(/own domain/);
    await expect(boot({ 43114: { ...base, cctp: { enabled: true, destinationDomains: [7, 7], minFinalityThreshold: 2000 } } })).rejects.toThrow(/twice/);
    await expect(boot({
      43114: {
        ...base,
        tokenCaps: { native: '0' },
        cctp: avaxCctp,
      },
    })).rejects.toThrow(/requires a token cap/);
    await expect(boot({
      43114: base,
      1: { enabled: false, cctp: { enabled: true, destinationDomains: [7], minFinalityThreshold: 2000 } },
    })).rejects.toThrow(/only supported on Avalanche 43114 and Polygon 137/);
    await expect(boot({
      43114: { ...base, cctp: { enabled: true, sourceDomains: [7], minFinalityThreshold: 2000 } },
    })).rejects.toThrow(/destinationDomains is required/);
    const polygon = {
      enabled: true,
      gas: { maxFeeUsd: 1 },
      tokenCaps: { native: '0', [POLY_USDC]: '1000000' },
      price: { prices: { native: 1 } },
    };
    await expect(boot({
      137: { ...polygon, cctp: { enabled: true, destinationDomains: [1], minFinalityThreshold: 2000 } },
    })).rejects.toThrow(/sourceDomains is required/);
    await expect(boot({
      137: { ...polygon, cctp: { enabled: true, sourceDomains: [1], minFinalityThreshold: 2000, maxExpirationBlock: 50 } },
    })).rejects.toThrow(/maxExpirationBlock must be a decimal block number/);
  });

  it('accepts an expiration inside the bound and keeps source and destination lists apart', async () => {
    const bounded = await boot({
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0', [AVAX_USDC]: '1000000' },
        price: { prices: { native: 1 } },
        cctp: { ...avaxCctp, sourceDomains: [7] },
      },
      137: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '1000000000000000000', [POLY_USDC]: '1000000' },
        price: { prices: { native: 1 } },
        cctp: { ...polyCctp, maxExpirationBlock: '50' },
      },
    });
    const atBound = await submit(bounded, 137, TRANSMITTER, receive(message({ expiration: 50n })), { nonce: '1', action: 'cctp-mint' });
    expect(atBound.signedTransaction).toMatch(/^0x/);
    await expect(submit(bounded, 137, TRANSMITTER, receive(message({ expiration: 51n })), { nonce: '2', action: 'cctp-mint' })).rejects.toThrow(/expiration/);
    const home = message({ source: 7, dest: 1, burnToken: POLY_USDC });
    await expect(submit(bounded, 43114, TRANSMITTER, receive(home), { nonce: '3', action: 'cctp-mint' })).resolves.toMatchObject({ signedTransaction: expect.stringMatching(/^0x/) });
    await bounded.server.close();

    const burnOnly = await boot();
    await expect(submit(burnOnly, 43114, TRANSMITTER, receive(home), { nonce: '4', action: 'cctp-mint' })).rejects.toThrow(/source domain/);
  });

  it('denies a revoke or CCTP label or amount that does not match the calldata', async () => {
    const h = await boot({
      43114: {
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '0', [AVAX_USDC]: '1000000' },
        price: { prices: { native: 1 } },
        cctp: avaxCctp,
        revokeOnly: { enabled: true },
      },
      137: {
        enabled: true,
        gas: { maxFeeUsd: 1 },
        tokenCaps: { native: '1000000000000000000', [POLY_USDC]: '1000000' },
        price: { prices: { native: 1 } },
        cctp: polyCctp,
      },
    });
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '1', action: 'burn' })).rejects.toThrow(/venue\/action must be cctp\/cctp-burn/);
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '2', venue: 'spot' })).rejects.toThrow(/venue\/action must be cctp\/cctp-burn/);
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '3', amountIn: '1' })).rejects.toThrow(/does not equal amountIn/);
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '4', tokenIn: { address: POLY_USDC, symbol: 'USDC', decimals: 6 } })).rejects.toThrow(/tokenIn/);
    await expect(submit(h, 43114, MESSENGER, burn(), { nonce: '5', tokenIn: undefined })).rejects.toThrow(/missing tokenIn/);
    const approved = ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]);
    await expect(submit(h, 43114, AVAX_USDC, approved, { nonce: '6', action: 'approve' })).rejects.toThrow(/venue\/action must be cctp\/cctp-approve/);
    await expect(submit(h, 43114, AVAX_USDC, approved, { nonce: '7', action: 'cctp-approve', amountIn: (AMOUNT - 1n).toString() })).rejects.toThrow(/does not equal amountIn/);
    await expect(submit(h, 137, TRANSMITTER, receive(), { nonce: '8', action: 'receive' })).rejects.toThrow(/venue\/action must be cctp\/cctp-mint/);
    await expect(submit(h, 137, TRANSMITTER, receive(), { nonce: '9', action: 'cctp-mint', amountIn: '1' })).rejects.toThrow(/does not equal amountIn/);
    const zero = ERC20.encodeFunctionData('approve', [MESSENGER, 0n]);
    await expect(submit(h, 43114, AVAX_USDC, zero, { nonce: '10', venue: 'revoke', action: 'approve', amountIn: '0' })).rejects.toThrow(/venue\/action must be revoke\/revoke/);
    await expect(submit(h, 43114, AVAX_USDC, zero, { nonce: '11', venue: 'revoke', action: 'revoke', amountIn: '1' })).rejects.toThrow(/does not equal amountIn/);
    const burned = await submit(h, 43114, MESSENGER, burn(), { nonce: '12' });
    expect(burned.signedTransaction).toMatch(/^0x/);
  });

  it('proposer helpers emit the venue and action the signer accepts', async () => {
    const h = await boot();
    const burned = buildCctpBurn({ wallet: WALLET, amount: AMOUNT });
    expect(burned).toMatchObject({ venue: 'cctp', action: 'cctp-burn', amountIn: AMOUNT.toString(), tokenIn: { address: AVAX_USDC } });
    expect((await submit(h, 43114, burned.to, burned.data, { nonce: '1', venue: burned.venue, action: burned.action, amountIn: burned.amountIn, tokenIn: burned.tokenIn })).signedTransaction).toMatch(/^0x/);
    const approved = buildCctpApprove(AMOUNT);
    expect(approved).toMatchObject({ venue: 'cctp', action: 'cctp-approve', amountIn: AMOUNT.toString(), tokenIn: { address: AVAX_USDC } });
    expect((await submit(h, 43114, approved.to, approved.data, { nonce: '2', venue: approved.venue, action: approved.action, amountIn: approved.amountIn, tokenIn: approved.tokenIn })).signedTransaction).toMatch(/^0x/);
    const minted = buildCctpMint({
      message: message(),
      attestation: `0x${'ab'.repeat(32)}`,
      chainId: 137,
      wallet: WALLET,
      config: polyCctp,
    });
    expect(minted).toMatchObject({ venue: 'cctp', action: 'cctp-mint', amountIn: AMOUNT.toString(), tokenIn: { address: POLY_USDC } });
    expect((await submit(h, 137, minted.to, minted.data, { nonce: '3', venue: minted.venue, action: minted.action, amountIn: minted.amountIn, tokenIn: minted.tokenIn })).signedTransaction).toMatch(/^0x/);
  });

  it('accepts the attested Avalanche to Polygon message and denies a bad sender or recipient', () => {
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/iris-e794.json'), 'utf8')) as {
      sourceTxHash: string;
      messages: Array<{ message: string; attestation: string }>;
    };
    expect(fixture.sourceTxHash).toBe('0xe794c5183035f2998c72083d2584fb59fd8bf3ea549926210afa30c25c3ddfae');
    const body = fixture.messages[0]!.message;
    const attestation = fixture.messages[0]!.attestation;
    expect((body.length - 2) / 2).toBe(376);
    expect(wordAt(body, 0)).toBe(1);
    expect(wordAt(body, 4)).toBe(1);
    expect(wordAt(body, 8)).toBe(7);
    expect(addressAt(body, 44)).toBe(MESSENGER);
    expect(addressAt(body, 76)).toBe(MESSENGER);
    expect(addressAt(body, 148 + 4)).toBe(AVAX_USDC);
    expect(addressAt(body, 148 + 36)).toBe(REAL_MINT);
    expect(uintAt(body, 148 + 68)).toBe(1_008_537_760n);
    expect(addressAt(body, 148 + 100)).toBe(REAL_MINT);
    expect(uintAt(body, 148 + 196)).toBe(0n);
    const config: CctpConfig = { enabled: true, sourceDomains: [1], minFinalityThreshold: CCTP_STANDARD_FINALITY };
    const decoded = takeCctp({
      chainId: 137,
      to: TRANSMITTER,
      data: receive(body, attestation),
      value: 0n,
      config,
      wallet: REAL_MINT,
    });
    expect(decoded).toMatchObject({ kind: 'cctp-mint', amount: 1_008_537_760n, asset: POLY_USDC });
    const built = buildCctpMint({ message: body, attestation, chainId: 137, wallet: REAL_MINT, config });
    expect(built).toMatchObject({
      venue: 'cctp',
      action: 'cctp-mint',
      amountIn: '1008537760',
      tokenIn: { address: POLY_USDC },
    });
    expect(() => takeCctp({
      chainId: 137,
      to: TRANSMITTER,
      data: receive(patchWord(body, 76, MINTER), attestation),
      value: 0n,
      config,
      wallet: REAL_MINT,
    })).toThrow(/recipient is not TokenMessengerV2/);
    expect(() => takeCctp({
      chainId: 137,
      to: TRANSMITTER,
      data: receive(patchWord(body, 44, MINTER), attestation),
      value: 0n,
      config,
      wallet: REAL_MINT,
    })).toThrow(/sender is not TokenMessengerV2/);
  });
});

const REAL_MINT = getAddress('0xe3ec8563551f049da5fc973472a7fb04cb940d08');

function wordAt(message: string, offset: number): number {
  return Number.parseInt(message.slice(2 + offset * 2, 2 + offset * 2 + 8), 16);
}

function uintAt(message: string, offset: number): bigint {
  return BigInt(`0x${message.slice(2 + offset * 2, 2 + offset * 2 + 64)}`);
}

function addressAt(message: string, offset: number): string {
  return getAddress(`0x${message.slice(2 + offset * 2 + 24, 2 + offset * 2 + 64)}`);
}

function patchWord(message: string, offset: number, address: string): string {
  const start = 2 + offset * 2;
  const word = getAddress(address).slice(2).toLowerCase().padStart(64, '0');
  return `${message.slice(0, start)}${word}${message.slice(start + 64)}`;
}
