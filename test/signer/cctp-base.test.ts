/**
 * CCTP V2 Avalanche <-> Base, treasury to treasury.
 *
 * The chain table (`CCTP_CHAINS`) enables Avalanche 43114 (domain 1) and
 * Base 8453 (domain 6) to burn and receive, keeps Polygon 137 receive-only,
 * and lists Arbitrum 42161 (domain 3) disabled. Every vector below is
 * either accepted end to end through the signer server or denied with the
 * rule that fired. The two Iris fixtures are attested mainnet Standard
 * messages read on 1 November 2026; both carry expirationBlock 0.
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
  ARBITRUM_NATIVE_USDC,
  BASE_NATIVE_USDC,
  CCTP_CHAINS,
  CCTP_MESSAGE_TRANSMITTER_V2,
  CCTP_STANDARD_FINALITY,
  CCTP_TOKEN_MESSENGER_V2,
  cctpChain,
  cctpDomain,
  takeCctp,
  type CctpConfig,
} from '../../src/signer/cctp';
import { computeApprovedTxHash, signVerifierApproval, type ApprovedTransaction, type SigningIntent } from '../../src/signer/intent';
import { AVALANCHE_NATIVE_USDC, POLYGON_NATIVE_USDC } from '../../src/signer/revoke-only';
import type { EvalancheSignerServer } from '../../src/signer/server';

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // gitleaks:allow  Hardhat/Anvil public test account #0, same key as cctp.test.ts
const WALLET = new Wallet(KEY).address;
const OTHER = getAddress('0x00000000000000000000000000000000000000ab');
const ZERO = '0x0000000000000000000000000000000000000000';
const MESSENGER = getAddress(CCTP_TOKEN_MESSENGER_V2);
const TRANSMITTER = getAddress(CCTP_MESSAGE_TRANSMITTER_V2);
const AVAX_USDC = getAddress(AVALANCHE_NATIVE_USDC);
const BASE_USDC = getAddress(BASE_NATIVE_USDC);
const ARB_USDC = getAddress(ARBITRUM_NATIVE_USDC);
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

function usdcOf(chainId: number): string {
  if (chainId === 8453) return BASE_USDC;
  if (chainId === 137) return POLY_USDC;
  if (chainId === 42161) return ARB_USDC;
  return AVAX_USDC;
}

function burn(patch: Partial<{
  amount: bigint;
  domain: number;
  mint: string;
  token: string;
  caller: string;
  maxFee: bigint;
  finality: number;
}> = {}, chainId = 43114): string {
  return MESSENGER_IFACE.encodeFunctionData('depositForBurn', [
    patch.amount ?? AMOUNT,
    patch.domain ?? (chainId === 8453 ? 1 : 6),
    word(patch.mint ?? WALLET),
    patch.token ?? usdcOf(chainId),
    word(patch.caller ?? ZERO),
    patch.maxFee ?? 0n,
    patch.finality ?? CCTP_STANDARD_FINALITY,
  ]);
}

function message(patch: Partial<{
  source: number;
  dest: number;
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
  const source = patch.source ?? 1;
  const header = [
    hex(1, 8),
    hex(source, 8),
    hex(patch.dest ?? 6, 8),
    u256(1n),
    addr(MESSENGER),
    addr(MESSENGER),
    addr(patch.caller ?? ZERO),
    hex(patch.minFinality ?? CCTP_STANDARD_FINALITY, 8),
    hex(patch.executed ?? CCTP_STANDARD_FINALITY, 8),
  ].join('');
  const body = [
    hex(1, 8),
    addr(patch.burnToken ?? (source === 6 ? BASE_USDC : AVAX_USDC)),
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

function receive(body = message(), attestation = `0x${'ab'.repeat(65)}`): string {
  return TRANSMITTER_IFACE.encodeFunctionData('receiveMessage', [body, attestation]);
}

/** Ops' proposed step-2 config shape, minus the live addresses. */
const avaxCctp: CctpConfig = {
  enabled: true,
  destinationDomains: [6],
  sourceDomains: [6],
  maxFee: '0',
  minFinalityThreshold: CCTP_STANDARD_FINALITY,
};
const baseCctp: CctpConfig = {
  enabled: true,
  destinationDomains: [1],
  sourceDomains: [1],
  maxFee: '0',
  minFinalityThreshold: CCTP_STANDARD_FINALITY,
};
/** No-caps: the USDC cap is present and is 2^256-1, as in the 23 Oct config. */
const NO_CAP = MaxUint256.toString();

function chainBlock(chainId: number, cctp: unknown, extra: Record<string, unknown> = {}) {
  return {
    ...(chainId === 43114 ? {} : { enabled: true }),
    gas: { maxFeeUsd: 1 },
    tokenCaps: { native: '0', [usdcOf(chainId)]: NO_CAP },
    price: { prices: { native: 1 } },
    cctp,
    ...extra,
  };
}

async function boot(chains: Record<string, unknown> = {
  43114: chainBlock(43114, avaxCctp),
  8453: chainBlock(8453, baseCctp),
}) {
  const root = await mkdtemp(join(tmpdir(), 'cctp-base-'));
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
      8453: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      137: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
      42161: [{ address: WALLET, selectors: ['0x'], roles: ['recipient'] }],
    },
    // Avalanche is on by default, so it always needs its caps.
    chains: { 43114: chainBlock(43114, undefined), ...chains } as never,
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
    intentId: `cctp-base-${chainId}-${patch.nonce}`,
    createdAt: now,
    expiresAt: now + 60_000,
    wallet: WALLET,
    chainId,
    venue: 'cctp',
    action: 'cctp-burn',
    amountIn: AMOUNT.toString(),
    tokenIn: { address: usdcOf(chainId), symbol: 'USDC', decimals: 6 },
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

interface IrisFixture {
  sourceTxHash: string;
  messages: Array<{ message: string; attestation: string; status: string; decodedMessage: Record<string, unknown> }>;
}

function fixture(name: string): IrisFixture {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')) as IrisFixture;
}

function u32At(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(2 + offset * 2, 2 + offset * 2 + 8), 16);
}
function uintAt(hex: string, offset: number): bigint {
  return BigInt(`0x${hex.slice(2 + offset * 2, 2 + offset * 2 + 64)}`);
}
function wordAt(hex: string, offset: number): string {
  return `0x${hex.slice(2 + offset * 2, 2 + offset * 2 + 64)}`;
}
function addressAt(hex: string, offset: number): string {
  return getAddress(`0x${hex.slice(2 + offset * 2 + 24, 2 + offset * 2 + 64)}`);
}
function patchWord(hex: string, offset: number, value: string): string {
  const start = 2 + offset * 2;
  return `${hex.slice(0, start)}${value.slice(2).padStart(64, '0')}${hex.slice(start + 64)}`;
}

describe('CCTP V2 chain table', () => {
  it('pins Circle addresses, enables Avalanche and Base, keeps Polygon receive-only and Arbitrum off', () => {
    expect(MESSENGER).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(TRANSMITTER).toBe('0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
    expect(BASE_USDC).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(AVAX_USDC).toBe('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E');
    expect(ARB_USDC).toBe('0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
    expect(CCTP_CHAINS.map((entry) => [entry.chainId, entry.domain, entry.burn, entry.receive, entry.enabled])).toEqual([
      [43114, 1, true, true, true],
      [8453, 6, true, true, true],
      [137, 7, false, true, true],
      [42161, 3, true, true, false],
    ]);
    expect(cctpChain(8453)).toMatchObject({ domain: 6, usdc: BASE_USDC });
    expect(cctpDomain(6)).toMatchObject({ chainId: 8453 });
    expect(cctpChain(42161)).toBeUndefined();
    expect(cctpDomain(3)).toBeUndefined();
    expect(CCTP_CHAINS.find((entry) => entry.chainId === 42161)?.expirationClock).toBe('ethereum');
    expect(CCTP_CHAINS.map((entry) => [entry.chainId, [...entry.allowedDestinationDomains]])).toEqual([
      [43114, [6, 7]],
      [8453, [1]],
      [137, []],
      [42161, [1]],
    ]);
    expect(Object.isFrozen(CCTP_CHAINS)).toBe(true);
    expect(Object.isFrozen(CCTP_CHAINS[0])).toBe(true);
    expect(Object.isFrozen(CCTP_CHAINS[1]!.allowedDestinationDomains)).toBe(true);
  });

  it('adds a route as data: an enabled Arbitrum row resolves without code changes', () => {
    const table = CCTP_CHAINS.map((entry) => (entry.chainId === 42161 ? { ...entry, enabled: true } : entry));
    expect(cctpChain(42161, table)).toMatchObject({ domain: 3, usdc: ARB_USDC, burn: true, receive: true });
    expect(cctpDomain(3, table)).toMatchObject({ chainId: 42161 });
    expect(cctpChain(42161)).toBeUndefined();
  });
});

describe('CCTP V2 Avalanche <-> Base: accept', () => {
  it('Avalanche burns to Base, approves exactly, and receives from Base', async () => {
    const h = await boot();
    expect((await submit(h, 43114, MESSENGER, burn(), { nonce: '1' })).signedTransaction).toMatch(/^0x/);
    const approve = ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]);
    expect((await submit(h, 43114, AVAX_USDC, approve, { nonce: '2', action: 'cctp-approve' })).signedTransaction).toMatch(/^0x/);
    const home = message({ source: 6, dest: 1 });
    expect((await submit(h, 43114, TRANSMITTER, receive(home), { nonce: '3', action: 'cctp-mint' })).signedTransaction).toMatch(/^0x/);
  });

  it('Base burns to Avalanche, approves exactly, and receives from Avalanche', async () => {
    const h = await boot();
    expect((await submit(h, 8453, MESSENGER, burn({}, 8453), { nonce: '1' })).signedTransaction).toMatch(/^0x/);
    const approve = ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]);
    expect((await submit(h, 8453, BASE_USDC, approve, { nonce: '2', action: 'cctp-approve' })).signedTransaction).toMatch(/^0x/);
    expect((await submit(h, 8453, TRANSMITTER, receive(message()), { nonce: '3', action: 'cctp-mint' })).signedTransaction).toMatch(/^0x/);
  });

  it('decodes the mint asset as the destination chain USDC', () => {
    const onBase = takeCctp({ chainId: 8453, to: TRANSMITTER, data: receive(message()), value: 0n, config: baseCctp, wallet: WALLET });
    expect(onBase).toMatchObject({ kind: 'cctp-mint', asset: BASE_USDC, amount: AMOUNT, receiver: WALLET });
    const onAvax = takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(message({ source: 6, dest: 1 })), value: 0n, config: avaxCctp, wallet: WALLET });
    expect(onAvax).toMatchObject({ kind: 'cctp-mint', asset: AVAX_USDC });
    const baseBurn = takeCctp({ chainId: 8453, to: MESSENGER, data: burn({}, 8453), value: 0n, config: baseCctp, wallet: WALLET });
    expect(baseBurn).toMatchObject({ kind: 'cctp-burn', asset: BASE_USDC, amount: AMOUNT });
    const baseApprove = takeCctp({ chainId: 8453, to: BASE_USDC, data: ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]), value: 0n, config: baseCctp, wallet: WALLET });
    expect(baseApprove).toMatchObject({ kind: 'erc20-approve', moduleOp: 'cctp-approve', asset: BASE_USDC, spender: MESSENGER, amount: AMOUNT });
  });

  it('proposer helpers build Base burns and approvals the signer accepts', async () => {
    const h = await boot();
    const burned = buildCctpBurn({ wallet: WALLET, amount: AMOUNT, chainId: 8453 });
    expect(burned).toMatchObject({ venue: 'cctp', action: 'cctp-burn', tokenIn: { address: BASE_USDC }, amountIn: AMOUNT.toString() });
    expect(MESSENGER_IFACE.decodeFunctionData('depositForBurn', burned.data)[1]).toBe(1n);
    expect((await submit(h, 8453, burned.to, burned.data, { nonce: '1', tokenIn: burned.tokenIn })).signedTransaction).toMatch(/^0x/);
    const toBase = buildCctpBurn({ wallet: WALLET, amount: AMOUNT, destinationDomain: 6 });
    expect(toBase.tokenIn.address).toBe(AVAX_USDC);
    expect((await submit(h, 43114, toBase.to, toBase.data, { nonce: '2' })).signedTransaction).toMatch(/^0x/);
    const approved = buildCctpApprove(AMOUNT, 8453);
    expect(approved).toMatchObject({ to: BASE_USDC, action: 'cctp-approve', tokenIn: { address: BASE_USDC } });
    expect((await submit(h, 8453, approved.to, approved.data, { nonce: '3', action: 'cctp-approve' })).signedTransaction).toMatch(/^0x/);
    expect(buildCctpApprove(AMOUNT).to).toBe(AVAX_USDC);
    expect(() => buildCctpApprove(AMOUNT, 137)).toThrow(/not enabled on chain 137/);
    expect(() => buildCctpApprove(AMOUNT, 42161)).toThrow(/not enabled on chain 42161/);
    expect(() => buildCctpBurn({ wallet: WALLET, amount: AMOUNT, destinationDomain: 3 })).toThrow(/domain 3 is not an enabled CCTP route/);
    expect(() => buildCctpBurn({ wallet: WALLET, amount: AMOUNT, chainId: 42161, destinationDomain: 1 })).toThrow(/not enabled on chain 42161/);
  });
});

describe('CCTP V2 Avalanche <-> Base: deny', () => {
  for (const chainId of [43114, 8453]) {
    const name = chainId === 8453 ? 'Base' : 'Avalanche';
    it(`${name} burn denies every field outside the pinned standard transfer`, async () => {
      const h = await boot();
      const s = (data: string, nonce: string, patch: Partial<SigningIntent> = {}, value = '0') =>
        submit(h, chainId, MESSENGER, data, { nonce, ...patch }, value);
      await expect(s(burn({ mint: OTHER }, chainId), '1')).rejects.toThrow(/mint recipient must be the treasury/);
      await expect(s(burn({ caller: OTHER }, chainId), '2')).rejects.toThrow(/destinationCaller/);
      await expect(s(burn({ caller: WALLET }, chainId), '3')).rejects.toThrow(/destinationCaller/);
      await expect(s(burn({ finality: 1000 }, chainId), '4')).rejects.toThrow(/minFinalityThreshold must be 2000/);
      await expect(s(burn({ maxFee: 1n }, chainId), '5')).rejects.toThrow(/maxFee exceeds/);
      const wrongToken = chainId === 8453 ? AVAX_USDC : BASE_USDC;
      await expect(s(burn({ token: wrongToken }, chainId), '6')).rejects.toThrow(new RegExp(`must be ${name} native USDC`));
      await expect(s(burn({ token: POLY_USDC }, chainId), '7')).rejects.toThrow(/native USDC/);
      await expect(s(burn({ domain: 3 }, chainId), '8')).rejects.toThrow(/destination domain is not allowlisted/);
      await expect(s(burn({ domain: 4 }, chainId), '9')).rejects.toThrow(/destination domain is not allowlisted/);
      await expect(s(burn({ domain: 0 }, chainId), '10')).rejects.toThrow(/destination domain is not allowlisted/);
      const hooked = MESSENGER_IFACE.encodeFunctionData('depositForBurnWithHook', [
        AMOUNT, chainId === 8453 ? 1 : 6, word(WALLET), usdcOf(chainId), word(ZERO), 0n, CCTP_STANDARD_FINALITY, '0x1234',
      ]);
      await expect(s(hooked, '11')).rejects.toThrow(/not depositForBurn/);
      await expect(s(`${burn({}, chainId)}00`, '12')).rejects.toThrow(/trailing/);
      await expect(s(burn({}, chainId), '13', {}, '1')).rejects.toThrow(/value must be 0/);
      await expect(s(burn({}, chainId), '14', { amountIn: (AMOUNT - 1n).toString() })).rejects.toThrow(/does not equal amountIn/);
      const ok = await s(burn({}, chainId), '15');
      expect(ok.signedTransaction).toMatch(/^0x/);
    });

    it(`${name} approval must be exact, to TokenMessengerV2 only`, async () => {
      const h = await boot();
      const token = usdcOf(chainId);
      const exact = ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]);
      await expect(submit(h, chainId, token, exact, { nonce: '1', action: 'cctp-approve', amountIn: (AMOUNT + 1n).toString() })).rejects.toThrow(/does not equal amountIn/);
      await expect(submit(h, chainId, token, exact, { nonce: '2', action: 'cctp-approve', amountIn: (AMOUNT - 1n).toString() })).rejects.toThrow(/does not equal amountIn/);
      const unlimited = ERC20.encodeFunctionData('approve', [MESSENGER, MaxUint256]);
      await expect(submit(h, chainId, token, unlimited, { nonce: '3', action: 'cctp-approve', amountIn: MaxUint256.toString() })).rejects.toThrow(/exact burn amount/);
      const stranger = ERC20.encodeFunctionData('approve', [OTHER, AMOUNT]);
      await expect(submit(h, chainId, token, stranger, { nonce: '4', action: 'cctp-approve' })).rejects.toThrow(/not allowlisted/);
      const transmitter = ERC20.encodeFunctionData('approve', [TRANSMITTER, AMOUNT]);
      await expect(submit(h, chainId, token, transmitter, { nonce: '5', action: 'cctp-approve' })).rejects.toThrow(/not allowlisted/);
      expect(takeCctp({ chainId, to: token, data: stranger, value: 0n, config: chainId === 8453 ? baseCctp : avaxCctp, wallet: WALLET })).toBeNull();
      await expect(submit(h, chainId, token, `${exact}00`, { nonce: '6', action: 'cctp-approve' })).rejects.toThrow(/trailing/);
      const wrongToken = chainId === 8453 ? AVAX_USDC : BASE_USDC;
      expect(takeCctp({ chainId, to: wrongToken, data: exact, value: 0n, config: chainId === 8453 ? baseCctp : avaxCctp, wallet: WALLET })).toBeNull();
      await expect(submit(h, chainId, wrongToken, exact, { nonce: '7', action: 'cctp-approve', tokenIn: { address: wrongToken, symbol: 'USDC', decimals: 6 } })).rejects.toThrow(/not allowlisted/);
      await expect(submit(h, chainId, token, exact, { nonce: '8', action: 'approve' })).rejects.toThrow(/venue\/action must be cctp\/cctp-approve/);
    });
  }

  it('Base receive denies wrong recipient, caller, hook, fast finality, fee, token, domains and expiry', async () => {
    const h = await boot();
    const r = (body: string, nonce: string) => submit(h, 8453, TRANSMITTER, receive(body), { nonce, action: 'cctp-mint' });
    await expect(r(message({ mint: OTHER }), '1')).rejects.toThrow(/mint recipient must be the treasury/);
    await expect(r(message({ callerOfBurn: OTHER }), '2')).rejects.toThrow(/burn caller is not the treasury/);
    await expect(r(message({ caller: WALLET }), '3')).rejects.toThrow(/destinationCaller/);
    await expect(r(message({ hook: '00' }), '4')).rejects.toThrow(/hook data is denied/);
    await expect(r(message({ minFinality: 1000, executed: 1000 }), '5')).rejects.toThrow(/finality must be 2000/);
    await expect(r(message({ executed: 1000 }), '6')).rejects.toThrow(/finality must be 2000/);
    await expect(r(message({ maxFee: 1n }), '7')).rejects.toThrow(/fee exceeds/);
    await expect(r(message({ fee: 1n, maxFee: 1n }), '8')).rejects.toThrow(/fee exceeds/);
    await expect(r(message({ burnToken: BASE_USDC }), '9')).rejects.toThrow(/pinned USDC/);
    await expect(r(message({ source: 3, burnToken: ARB_USDC }), '10')).rejects.toThrow(/source domain is not allowlisted/);
    await expect(r(message({ source: 7, burnToken: POLY_USDC }), '11')).rejects.toThrow(/source domain is not allowlisted/);
    await expect(r(message({ dest: 1 }), '12')).rejects.toThrow(/destination domain is not this chain/);
    await expect(r(message({ dest: 3 }), '13')).rejects.toThrow(/destination domain is not this chain/);
    await expect(r(message({ expiration: 1n }), '14')).rejects.toThrow(/expiration/);
    const ok = await r(message(), '15');
    expect(ok.signedTransaction).toMatch(/^0x/);
  });

  it('a hand-built config cannot route through disabled Arbitrum or an unknown domain', () => {
    const loose = { enabled: true, destinationDomains: [3, 0], sourceDomains: [3], minFinalityThreshold: CCTP_STANDARD_FINALITY } as CctpConfig;
    expect(() => takeCctp({ chainId: 43114, to: MESSENGER, data: burn({ domain: 3 }), value: 0n, config: loose, wallet: WALLET })).toThrow(/not an enabled CCTP route/);
    expect(() => takeCctp({ chainId: 43114, to: MESSENGER, data: burn({ domain: 0 }), value: 0n, config: loose, wallet: WALLET })).toThrow(/not an enabled CCTP route/);
    expect(() => takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(message({ source: 3, dest: 1, burnToken: ARB_USDC })), value: 0n, config: loose, wallet: WALLET })).toThrow(/pinned USDC/);
    const self = { enabled: true, destinationDomains: [6], minFinalityThreshold: CCTP_STANDARD_FINALITY } as CctpConfig;
    expect(() => takeCctp({ chainId: 8453, to: MESSENGER, data: burn({ domain: 6 }, 8453), value: 0n, config: self, wallet: WALLET })).toThrow(/not an enabled CCTP route/);
  });

  it('receive and burn are refused on chains outside the enabled table', () => {
    const config = { enabled: true, destinationDomains: [1], sourceDomains: [1], minFinalityThreshold: CCTP_STANDARD_FINALITY } as CctpConfig;
    for (const chainId of [42161, 10, 1]) {
      expect(() => takeCctp({ chainId, to: TRANSMITTER, data: receive(message({ dest: 3 })), value: 0n, config, wallet: WALLET })).toThrow(/receive is only signed on Avalanche 43114, Base 8453 and Polygon 137/);
      expect(() => takeCctp({ chainId, to: MESSENGER, data: burn({ domain: 1, token: ARB_USDC }), value: 0n, config, wallet: WALLET })).toThrow(/burn is only signed on Avalanche 43114 and Base 8453/);
      expect(takeCctp({ chainId, to: ARB_USDC, data: ERC20.encodeFunctionData('approve', [MESSENGER, AMOUNT]), value: 0n, config, wallet: WALLET })).toBeNull();
    }
    expect(() => takeCctp({ chainId: 137, to: MESSENGER, data: burn({ token: POLY_USDC, domain: 1 }), value: 0n, config, wallet: WALLET })).toThrow(/burn is only signed on/);
  });

  it('fails startup for Arbitrum, unknown domains, Polygon burns and a missing USDC cap', async () => {
    await expect(boot({ 42161: chainBlock(42161, baseCctp) })).rejects.toThrow(/only supported on Avalanche 43114, Base 8453 and Polygon 137/);
    await expect(boot({ 43114: chainBlock(43114, { ...avaxCctp, destinationDomains: [3] }) })).rejects.toThrow(/domain 3, which is not an enabled CCTP route/);
    await expect(boot({ 43114: chainBlock(43114, { ...avaxCctp, sourceDomains: [3] }) })).rejects.toThrow(/domain 3, which is not an enabled CCTP route/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [0] }) })).rejects.toThrow(/domain 0, which is not an enabled CCTP route/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [4] }) })).rejects.toThrow(/not a Circle domain/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [6] }) })).rejects.toThrow(/own domain/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, minFinalityThreshold: 1000 }) })).rejects.toThrow(/must be 2000/);
    await expect(boot({ 8453: chainBlock(8453, { enabled: true, sourceDomains: [1], minFinalityThreshold: 2000 }) })).rejects.toThrow(/destinationDomains is required/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, hookData: '0x' }) })).rejects.toThrow(/not a CCTP setting/);
    await expect(boot({ 8453: chainBlock(8453, baseCctp, { tokenCaps: { native: '0' } }) })).rejects.toThrow(/requires a token cap for 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/);
    await expect(boot({ 137: chainBlock(137, { enabled: true, sourceDomains: [1], destinationDomains: [1], minFinalityThreshold: 2000 }) })).rejects.toThrow(/does not burn/);
    const ok = await boot({ 8453: chainBlock(8453, baseCctp), 137: chainBlock(137, { enabled: true, sourceDomains: [1, 6], minFinalityThreshold: 2000 }) });
    expect(ok.server).toBeTruthy();
  });

  it('stays off on Base until enabled', async () => {
    const off = await boot({ 8453: chainBlock(8453, undefined) });
    await expect(submit(off, 8453, MESSENGER, burn({}, 8453), { nonce: '1' })).rejects.toThrow(/not allowlisted/);
  });
});

describe('CCTP V2 Base burns only to Avalanche', () => {
  it('denies Base -> Polygon at request time, even when a hand-built config lists 7', async () => {
    const loose = { ...baseCctp, destinationDomains: [1, 7] } as CctpConfig;
    expect(() => takeCctp({ chainId: 8453, to: MESSENGER, data: burn({ domain: 7 }, 8453), value: 0n, config: loose, wallet: WALLET })).toThrow(/burn from Base may not target domain 7/);
    expect(takeCctp({ chainId: 8453, to: MESSENGER, data: burn({ domain: 1 }, 8453), value: 0n, config: loose, wallet: WALLET })).toMatchObject({ kind: 'cctp-burn', asset: BASE_USDC });
    const h = await boot();
    await expect(submit(h, 8453, MESSENGER, burn({ domain: 7 }, 8453), { nonce: '1' })).rejects.toThrow(/destination domain is not allowlisted/);
    expect((await submit(h, 8453, MESSENGER, burn({ domain: 1 }, 8453), { nonce: '2' })).signedTransaction).toMatch(/^0x/);
    expect(() => buildCctpBurn({ wallet: WALLET, amount: AMOUNT, chainId: 8453, destinationDomain: 7 })).toThrow(/burn from Base may not target domain 7/);
  });

  it('fails startup when Base destinationDomains lists anything but 1', async () => {
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [7] }) })).rejects.toThrow(/destinationDomains has domain 7, which Base 8453 may not burn to \(allowed: 1\)/);
    await expect(boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [1, 7] }) })).rejects.toThrow(/domain 7, which Base 8453 may not burn to/);
    const ok = await boot({ 8453: chainBlock(8453, { ...baseCctp, destinationDomains: [1] }) });
    expect(ok.server).toBeTruthy();
  });

  it('keeps Avalanche -> Polygon (rc.7) and Avalanche -> Base', async () => {
    const h = await boot({ 43114: chainBlock(43114, { ...avaxCctp, destinationDomains: [6, 7] }) });
    expect((await submit(h, 43114, MESSENGER, burn({ domain: 7 }), { nonce: '1' })).signedTransaction).toMatch(/^0x/);
    expect((await submit(h, 43114, MESSENGER, burn({ domain: 6 }), { nonce: '2' })).signedTransaction).toMatch(/^0x/);
  });
});

describe('CCTP V2 real attested mainnet messages (Iris, 1 November 2026)', () => {
  it('Avalanche -> Base 0x07fabfb0: field breakdown, expirationBlock 0, accepted on Base for its treasury', () => {
    const f = fixture('iris-1to6-07fa.json');
    expect(f.sourceTxHash).toBe('0x07fabfb0d32fc0d71f5ef88d0fa86c0d192c88a01bf70c5dcf35cbf32248a3e8');
    const m = f.messages[0]!;
    expect(m.status).toBe('complete');
    const hex = m.message;
    expect((hex.length - 2) / 2).toBe(376);
    expect(u32At(hex, 0)).toBe(1); // version
    expect(u32At(hex, 4)).toBe(1); // sourceDomain Avalanche
    expect(u32At(hex, 8)).toBe(6); // destinationDomain Base
    expect(wordAt(hex, 12)).toBe('0x5a14d3b0c950ce3c19bb0bbd69639a7109897c83035cf74fd98742d942abaff8'); // nonce
    expect(addressAt(hex, 44)).toBe(MESSENGER); // sender
    expect(addressAt(hex, 76)).toBe(MESSENGER); // recipient
    expect(wordAt(hex, 108)).toBe(`0x${'0'.repeat(64)}`); // destinationCaller
    expect(u32At(hex, 140)).toBe(2000); // minFinalityThreshold
    expect(u32At(hex, 144)).toBe(2000); // finalityThresholdExecuted
    expect(u32At(hex, 148)).toBe(1); // body version
    expect(addressAt(hex, 148 + 4)).toBe(AVAX_USDC); // burnToken
    const treasury = addressAt(hex, 148 + 36);
    expect(treasury).toBe(getAddress('0x65a8f07bd9a8598e1b5b6c0a88f4779dbc077675')); // mintRecipient
    expect(uintAt(hex, 148 + 68)).toBe(50_000_000_000n); // amount, 50,000 USDC
    expect(addressAt(hex, 148 + 100)).toBe(treasury); // messageSender
    expect(uintAt(hex, 148 + 132)).toBe(0n); // maxFee
    expect(uintAt(hex, 148 + 164)).toBe(0n); // feeExecuted
    expect(uintAt(hex, 148 + 196)).toBe(0n); // expirationBlock
    expect((m.decodedMessage.decodedMessageBody as Record<string, unknown>).expirationBlock).toBe('0');
    const decoded = takeCctp({ chainId: 8453, to: TRANSMITTER, data: receive(hex, m.attestation), value: 0n, config: baseCctp, wallet: treasury });
    expect(decoded).toMatchObject({ kind: 'cctp-mint', amount: 50_000_000_000n, asset: BASE_USDC, receiver: treasury });
    expect(buildCctpMint({ message: hex, attestation: m.attestation, chainId: 8453, wallet: treasury, config: baseCctp })).toMatchObject({
      action: 'cctp-mint', amountIn: '50000000000', tokenIn: { address: BASE_USDC },
    });
    expect(() => takeCctp({ chainId: 8453, to: TRANSMITTER, data: receive(hex, m.attestation), value: 0n, config: baseCctp, wallet: WALLET })).toThrow(/mint recipient must be the treasury/);
    expect(() => takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(hex, m.attestation), value: 0n, config: avaxCctp, wallet: treasury })).toThrow(/not this chain/);
    expect(() => takeCctp({ chainId: 8453, to: TRANSMITTER, data: receive(patchWord(hex, 148 + 196, '0x01'), m.attestation), value: 0n, config: baseCctp, wallet: treasury })).toThrow(/expiration/);
  });

  it('Base -> Avalanche 0x27e1c525: field breakdown, expirationBlock 0, accepted on Avalanche for its treasury', () => {
    const f = fixture('iris-6to1-27e1.json');
    expect(f.sourceTxHash).toBe('0x27e1c5250f9c8234936740a0e0566dfebc396d2d69c44e5a4969c9cb36602cff');
    const m = f.messages[0]!;
    expect(m.status).toBe('complete');
    const hex = m.message;
    expect((hex.length - 2) / 2).toBe(376);
    expect(u32At(hex, 4)).toBe(6);
    expect(u32At(hex, 8)).toBe(1);
    expect(addressAt(hex, 44)).toBe(MESSENGER);
    expect(addressAt(hex, 76)).toBe(MESSENGER);
    expect(wordAt(hex, 108)).toBe(`0x${'0'.repeat(64)}`);
    expect(u32At(hex, 140)).toBe(2000);
    expect(u32At(hex, 144)).toBe(2000);
    expect(addressAt(hex, 148 + 4)).toBe(BASE_USDC);
    const treasury = addressAt(hex, 148 + 36);
    expect(treasury).toBe(getAddress('0x5afe2414f865cbc5ff4e25979996c5b1252e0002'));
    expect(uintAt(hex, 148 + 68)).toBe(100_000_000_000n);
    expect(addressAt(hex, 148 + 100)).toBe(treasury);
    expect(uintAt(hex, 148 + 132)).toBe(0n);
    expect(uintAt(hex, 148 + 164)).toBe(0n);
    expect(uintAt(hex, 148 + 196)).toBe(0n);
    const decoded = takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(hex, m.attestation), value: 0n, config: avaxCctp, wallet: treasury });
    expect(decoded).toMatchObject({ kind: 'cctp-mint', amount: 100_000_000_000n, asset: AVAX_USDC, receiver: treasury });
    const strangerSender = patchWord(hex, 148 + 100, word(OTHER));
    expect(() => takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(strangerSender, m.attestation), value: 0n, config: avaxCctp, wallet: treasury })).toThrow(/burn caller is not the treasury/);
    const fast = `${hex.slice(0, 2 + 140 * 2)}000003e8000003e8${hex.slice(2 + 148 * 2)}`;
    expect(u32At(fast, 140)).toBe(1000);
    expect(() => takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(fast, m.attestation), value: 0n, config: avaxCctp, wallet: treasury })).toThrow(/finality must be 2000/);
    expect(() => takeCctp({ chainId: 43114, to: TRANSMITTER, data: receive(`${hex}00`, m.attestation), value: 0n, config: avaxCctp, wallet: treasury })).toThrow(/hook data is denied/);
  });
});
