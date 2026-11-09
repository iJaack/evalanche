import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypedDataEncoder, Wallet, getAddress, verifyTypedData } from 'ethers';
import { EvalancheSignerServer, AUDIT_ROOT, type SignerServerOptions } from '../../src/signer/server';
import { assertHyperliquidWithdraw3, fetchHyperliquidInfo, HYPERLIQUID_WITHDRAW_DESTINATION as DEST, HYPERLIQUID_WITHDRAW_TYPE as TYPE, HyperliquidNonceStore, hyperliquidNoncePath, type HyperliquidInfoFetcher } from '../../src/signer/hyperliquid-withdraw';
import { computeTypedDataRouteHash, generateEd25519KeyPair, signVerifierApproval, type CanonicalSigningRequest, type SigningIntent, type TypedDataPayload } from '../../src/signer/intent';

const KEY = `0x${'11'.repeat(32)}`;
const wallet = new Wallet(KEY);
const HL_DENY = 'Hyperliquid typed data is denied by domain and type';
const roots: string[] = [];
const servers: EvalancheSignerServer[] = [];
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  network = vi.fn(() => { throw new Error('Default fetch must never run'); });
  vi.stubGlobal('fetch', network);
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function payload(time = Date.now(), amount: unknown = '32.375424'): TypedDataPayload {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 421614, verifyingContract: `0x${'0'.repeat(40)}` },
    types: { [TYPE]: [
      { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' },
      { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' },
    ] },
    value: { hyperliquidChain: 'Mainnet', destination: DEST.toLowerCase(), amount, time },
  };
}
const domainFields = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
async function boot(extra: Partial<SignerServerOptions> = {}, fetcher: HyperliquidInfoFetcher = async () => ({ withdrawable: '32.375424', assetPositions: [], time: Date.now() })) {
  const tempRoot = join(process.cwd(), '.release-artifacts');
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, 'hl-withdraw-test-'));
  roots.push(root);
  const verifier = generateEd25519KeyPair();
  const options: SignerServerOptions = {
    privateKey: KEY, verifierPublicKey: verifier.publicKey, token: 'throwaway-test-token',
    auditLogPath: join(root, 'audit.jsonl'), nonceStorePath: join(root, 'nonces.json'),
    allow: { '43114': [{ address: `0x${'22'.repeat(20)}`, selectors: ['0x'] }] },
    chainId: 43114, initNonces: true, allowInsecureFilePermissions: true,
    explicitAllows: ['hyperliquid-withdraw3'], ...extra,
  };
  const info = vi.fn(fetcher);
  const server = await EvalancheSignerServer.create(options, info);
  servers.push(server);
  return { server, verifier, options, info };
}
type Harness = Awaited<ReturnType<typeof boot>>;
function request(h: Harness, typed = payload(), changes: Partial<SigningIntent> = {}, chainId = 421614): CanonicalSigningRequest {
  const now = Date.now();
  const intent: SigningIntent = {
    version: '1', intentId: 'withdraw-test', nonce: '1', createdAt: now, expiresAt: now + 60_000,
    wallet: wallet.address, chainId, venue: 'hyperliquid', action: 'hyperliquid-withdraw',
    tier: 'core', sleeve: 'cash', sizePctOfTreasury: 1, postFrictionEvUsd: '0', signalRefs: ['test'],
    routeHash: computeTypedDataRouteHash(typed), ...changes,
  };
  return {
    requestId: 'withdraw-test', kind: 'typed-data', chainId, from: wallet.address,
    intent: 'Withdraw to the pinned treasury', typedData: typed, structuredIntent: intent,
    approval: signVerifierApproval({ intent, verifierPrivateKey: h.verifier.privateKey, verifierPublicKey: h.verifier.publicKey, mode: h.options.dryRun ? 'dry-run' : 'live' }),
  };
}
async function stored(h: Harness) {
  return readFile(hyperliquidNoncePath(h.options.nonceStorePath), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}
async function denied(h: Harness, req: CanonicalSigningRequest, reason?: string) {
  const before = await stored(h);
  await expect(h.server.handle(req)).rejects.toMatchObject({ code: 'SIGNER_REJECTED', ...(reason ? { message: reason } : {}) });
  expect(await stored(h)).toBe(before);
}

describe('Hyperliquid withdraw3', () => {
  it('matches the independent SDK hash and signature vector', async () => {
    // hyperliquid-dex/hyperliquid-python-sdk, hyperliquid/utils/signing.py + exchange.py,
    // commit 2fdb18f9517675ea03695a0962bd19eece9c83f0; cross-checked with eth-account 0.13.7 and ethers v6.
    const typed = payload(1762689600000);
    expect(TypedDataEncoder.hashDomain(typed.domain)).toBe('0xfeb1393ca4412a4ca577bd51d04f0a77033514c602f4d0a11490fb95f7428df6');
    expect(TypedDataEncoder.from(typed.types).hash(typed.value)).toBe('0xf2c76eefba31c3620e0a21c6d02d538dadc4c92fd06ecbff3aa6a55f38d1dadd');
    expect(TypedDataEncoder.hash(typed.domain, typed.types, typed.value)).toBe('0x3caefaf95c3e1c0821d2c1d3a48f7190bb8e39ed593a944eb139dbdae2bd8c49');
    expect(await wallet.signTypedData(typed.domain, typed.types, typed.value)).toBe('0xc5ae65325519ac8a5efbedc18c20c1d077c113aaea7496dc80c26a2487c595753dd9c0ccb9455b95581ae40c1e52ec30b720cd17d6745fbae99869222f16edd91b');
  });

  it.each(['32.375424', '1'])('signs amount %s, persists nonce and chains the audit', async (amount) => {
    const h = await boot();
    const typed = payload(Date.now(), amount);
    const result = await h.server.handle(request(h, typed));
    expect(verifyTypedData(typed.domain, typed.types, typed.value, result.signature!)).toBe(wallet.address);
    expect(result.signedTransaction).toBeUndefined();
    expect(h.info).toHaveBeenCalledWith(wallet.address.toLowerCase());
    expect(JSON.parse((await stored(h))!).wallets[wallet.address.toLowerCase()]).toEqual({ lastTime: String(typed.value.time), used: [String(typed.value.time)] });
    expect((await stat(hyperliquidNoncePath(h.options.nonceStorePath))).mode & 0o777).toBe(0o600);
    const first = (await readFile(h.options.auditLogPath, 'utf8')).trim();
    const audit = JSON.parse(first);
    expect(audit.prevHash).toBe(AUDIT_ROOT);
    expect(audit.hyperliquid).toEqual({ action: 'withdraw3', destination: DEST.toLowerCase(), amount, time: typed.value.time, withdrawable: '32.375424' });
    const again = request(h, payload(typed.value.time as number), { nonce: '2' });
    await denied(h, again, 'Hyperliquid withdraw3: time must be greater than the last recorded Hyperliquid nonce');
    const second = JSON.parse((await readFile(h.options.auditLogPath, 'utf8')).trim().split('\n')[1]);
    expect(second.decision).toBe('deny');
    expect(second.hyperliquid.action).toBe('withdraw3');
    expect(second.prevHash).toBe(createHash('sha256').update(first).digest('hex'));
  });
  it('supports the SDK optional EIP712Domain and primaryType', async () => {
    const h = await boot();
    const typed = { ...payload(), primaryType: TYPE };
    typed.types.EIP712Domain = domainFields;
    const result = await h.server.handle(request(h, typed));
    expect(verifyTypedData(typed.domain, { [TYPE]: typed.types[TYPE] }, typed.value, result.signature!)).toBe(wallet.address);
  });
  it.each([DEST.toLowerCase(), `0x${DEST.slice(2).toUpperCase()}`, getAddress(DEST.toLowerCase())])('accepts valid address encoding %s', async (destination) => {
    const h = await boot();
    const typed = payload(); typed.value.destination = destination;
    expect((await h.server.handle(request(h, typed))).signature).toBeDefined();
  });
  it('dry-run consumes both nonces and audits without a signature', async () => {
    const h = await boot({ dryRun: true });
    const typed = payload();
    expect(await h.server.handle(request(h, typed))).toEqual({ requestId: 'withdraw-test', dryRun: true, decision: 'allow' });
    expect(JSON.parse((await stored(h))!).wallets[wallet.address.toLowerCase()].lastTime).toBe(String(typed.value.time));
    expect(JSON.parse(await readFile(h.options.nonceStorePath, 'utf8')).wallets[wallet.address.toLowerCase()].lastNonce).toBe('1');
    expect(JSON.parse((await readFile(h.options.auditLogPath, 'utf8')).trim())).toMatchObject({ decision: 'dry_run', hyperliquid: { withdrawable: '32.375424' } });
  });
  it('keeps the exact SDK withdraw denied without the flag', async () => {
    const h = await boot({ explicitAllows: [], chainIds: [43114, 421614] });
    await denied(h, request(h), HL_DENY);
    expect(h.info).not.toHaveBeenCalled();
  });
  it.each(['without flag', 'non-withdraw schema'])('does not bypass chain enablement: %s', async (variant) => {
    const h = await boot({ explicitAllows: variant === 'without flag' ? [] : ['hyperliquid-withdraw3'] });
    const typed = payload();
    if (variant === 'non-withdraw schema') typed.types.Foo = [{ name: 'foo', type: 'string' }];
    await denied(h, request(h, typed), 'chainId 421614 is not allowed');
  });

  const otherActions = [
    ['UsdSend', 'hyperliquidChain:string,destination:string,amount:string,time:uint64'],
    ['SpotSend', 'hyperliquidChain:string,destination:string,token:string,amount:string,time:uint64'],
    ['UsdClassTransfer', 'hyperliquidChain:string,amount:string,toPerp:bool,nonce:uint64'],
    ['ApproveAgent', 'hyperliquidChain:string,agentAddress:address,agentName:string,nonce:uint64'],
    ['ApproveBuilderFee', 'hyperliquidChain:string,maxFeeRate:string,builder:address,nonce:uint64'],
    ['SubAccountTransfer', 'hyperliquidChain:string,amount:string,nonce:uint64'],
    ['TokenDelegate', 'hyperliquidChain:string,validator:address,wei:uint64,isUndelegate:bool,nonce:uint64'],
    ['CDeposit', 'hyperliquidChain:string,wei:uint64,nonce:uint64'],
    ['SendAsset', 'hyperliquidChain:string,destination:string,sourceDex:string,destinationDex:string,token:string,amount:string,fromSubAccount:string,nonce:uint64'],
    ['Foo', 'hyperliquidChain:string'],
  ];
  it.each(otherActions)('retains the HL deny for %s with flag on', async (action, spec) => {
    const h = await boot({ chainIds: [43114, 421614] });
    const typed = payload();
    typed.types = { [`HyperliquidTransaction:${action}`]: spec.split(',').map((field) => { const [name, type] = field.split(':'); return { name, type }; }) };
    await denied(h, request(h, typed), HL_DENY);
    expect(h.info).not.toHaveBeenCalled();
  });
  it.each(['order', 'cancel', 'updateLeverage', 'spot order', 'vaultTransfer', 'sub-account action'])('denies L1 Agent %s', async () => {
    const h = await boot({ chainIds: [43114, 1337] });
    const typed: TypedDataPayload = { domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: `0x${'0'.repeat(40)}` }, types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, value: { source: 'a', connectionId: `0x${'22'.repeat(32)}` } };
    await denied(h, request(h, typed, {}, 1337), HL_DENY);
  });

  const mutations: Array<[string, (t: TypedDataPayload) => void]> = [
    ['extra field', t => { t.types[TYPE].push({ name: 'extra', type: 'string' }); }],
    ['missing field', t => { t.types[TYPE].pop(); }],
    ['reordered fields', t => { t.types[TYPE].reverse(); }],
    ['renamed field', t => { t.types[TYPE][0].name = 'chain'; }],
    ['time uint256', t => { t.types[TYPE][3].type = 'uint256'; }],
    ['destination address', t => { t.types[TYPE][1].type = 'address'; }],
    ['extra field property', t => { Object.assign(t.types[TYPE][0], { extra: true }); }],
    ['extra struct', t => { t.types.Foo = [{ name: 'x', type: 'string' }]; }],
    ['wrong EIP712Domain', t => { t.types.EIP712Domain = [...domainFields].reverse(); }],
    ['extra signatureChainId value', t => { t.value.signatureChainId = '0x66eee'; }],
    ['extra type value', t => { t.value.type = 'withdraw3'; }],
    ['missing value', t => { delete t.value.amount; }],
    ['wrong primaryType', t => { Object.assign(t, { primaryType: 'HyperliquidTransaction:UsdSend' }); }],
    ['wrong domain name', t => { t.domain.name = 'Foo'; }],
    ['wrong domain version', t => { t.domain.version = '2'; }],
    ...[42161, '0xa4b1', 1337, 999, '0x66eee', '421614'].map(chainId => [`domain chainId ${chainId}`, (t: TypedDataPayload) => { t.domain.chainId = chainId; }] as [string, (t: TypedDataPayload) => void]),
    ['nonzero contract', t => { t.domain.verifyingContract = wallet.address; }],
    ['extra domain key', t => { t.domain.salt = `0x${'00'.repeat(32)}`; }],
    ['missing domain key', t => { delete t.domain.version; }],
  ];
  it.each(mutations)('denies malformed schema: %s', async (_, mutate) => {
    const h = await boot({ chainIds: [43114, 421614] });
    const typed = payload(); mutate(typed);
    const req = request(h, typed);
    expect(() => assertHyperliquidWithdraw3(req, req.structuredIntent!)).toThrow(/^Hyperliquid withdraw3: /);
    await denied(h, req, HL_DENY);
    expect(h.info).not.toHaveBeenCalled();
  });
  it.each(['Testnet', 'mainnet'])('denies hyperliquidChain %s', async chain => {
    const h = await boot(); const typed = payload(); typed.value.hyperliquidChain = chain;
    await denied(h, request(h, typed), 'Hyperliquid withdraw3: hyperliquidChain must be Mainnet');
  });
  it.each([`0x${'22'.repeat(20)}`, wallet.address, '0x123', `0x${'gg'.repeat(20)}`, '0x0Fe61780bd5508b3c99e420662050e5560608ca4', ` ${DEST}`, `${DEST} `])('denies destination %s', async destination => {
    const h = await boot(); const typed = payload(); typed.value.destination = destination;
    await denied(h, request(h, typed)); expect(h.info).not.toHaveBeenCalled();
  });
  it.each(['0', '0.0', '-1', '1e3', '1.1234567', '01', ' 1', '', 1, 'NaN', 'Infinity', '1000000000000', '+1', '1.'])('denies invalid amount %s', async amount => {
    const h = await boot(); await denied(h, request(h, payload(Date.now(), amount)));
    expect(h.info).not.toHaveBeenCalled();
  });
  it('denies amount greater than withdrawable exactly', async () => {
    const h = await boot(); await denied(h, request(h, payload(Date.now(), '32.375425')), 'Hyperliquid withdraw3: amount exceeds withdrawable balance');
    const audit = JSON.parse((await readFile(h.options.auditLogPath, 'utf8')).trim());
    expect(audit.hyperliquid.withdrawable).toBe('32.375424');
    expect(JSON.parse(await readFile(h.options.nonceStorePath, 'utf8')).wallets).toEqual({});
  });
  it.each([['old', () => Date.now() - 300_001], ['future', () => Date.now() + 60_001], ['fractional', () => Date.now() + 0.1], ['negative', () => -1], ['unsafe', () => Number.MAX_SAFE_INTEGER + 1], ['string', () => String(Date.now())]])('denies time %s', async (_, time) => {
    const h = await boot();
    // Pin Date.now so freshness boundaries cannot move during approval verification.
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const typed = payload();
    const req = request(h, typed);
    typed.value.time = time();
    // Unsafe/fractional values are rejected by existing route canonicalisation first.
    const value = typed.value.time;
    await denied(h, typeof value === 'number' && !Number.isSafeInteger(value) ? req : request(h, typed));
    expect(h.info).not.toHaveBeenCalled();
  });
  it.each(['equal', 'lower'])('denies %s HL nonce independently of approval nonce', async variant => {
    const h = await boot(); const time = Date.now();
    await h.server.handle(request(h, payload(time)));
    await denied(h, request(h, payload(time - (variant === 'lower' ? 1 : 0)), { nonce: '2' }), 'Hyperliquid withdraw3: time must be greater than the last recorded Hyperliquid nonce');
  });
  const badStates: Array<[string, () => unknown]> = [
    ['stale time', () => ({ withdrawable: '100', assetPositions: [], time: Date.now() - 30_001 })],
    ['future time', () => ({ withdrawable: '100', assetPositions: [], time: Date.now() + 30_001 })],
    ['missing time', () => ({ withdrawable: '100', assetPositions: [] })],
    ['missing withdrawable', () => ({ assetPositions: [], time: Date.now() })],
    ['non-decimal withdrawable', () => ({ withdrawable: '1e3', assetPositions: [], time: Date.now() })],
    ['numeric withdrawable', () => ({ withdrawable: 100, assetPositions: [], time: Date.now() })],
    ['nine-decimal withdrawable', () => ({ withdrawable: '100.000000001', assetPositions: [], time: Date.now() })],
    ['zero withdrawable', () => ({ withdrawable: '0', assetPositions: [], time: Date.now() })],
    ['open position', () => ({ withdrawable: '100', assetPositions: [{}], time: Date.now() })],
    ['missing positions', () => ({ withdrawable: '100', time: Date.now() })],
    ['non-array positions', () => ({ withdrawable: '100', assetPositions: {}, time: Date.now() })],
    ['non-object', () => null],
  ];
  it.each(badStates)('fails closed for %s', async (_, state) => {
    const h = await boot({}, async () => state()); await denied(h, request(h));
  });
  it('fails closed when the info fetcher throws or times out', async () => {
    const h = await boot({}, async () => { throw new Error('timeout'); });
    await denied(h, request(h), 'Hyperliquid withdraw3: clearinghouseState read failed');
  });
  it('compares eight-decimal balances with integer arithmetic', async () => {
    const h = await boot({}, async () => ({ withdrawable: '32.37542399', assetPositions: [], time: Date.now() }));
    await denied(h, request(h), 'Hyperliquid withdraw3: amount exceeds withdrawable balance');
  });
  it.each([{ venue: 'Hyperliquid' }, { venue: 'spot' }, { action: 'hyperliquid' }, { action: 'withdraw' }])('denies mismatched intent %j', async intent => {
    const h = await boot(); await denied(h, request(h, payload(), intent));
  });
  it('denies request.chainId 999 with an otherwise exact payload', async () => {
    const h = await boot(); await denied(h, request(h, payload(), {}, 999), 'chainId 999 is not allowed');
  });
  it('checks request.chainId 999 even when allowed by chain config', async () => {
    const h = await boot({ chainIds: [43114, 999] }); await denied(h, request(h, payload(), {}, 999), HL_DENY);
  });
  it('retains the route hash and intent chain bindings', async () => {
    const h = await boot();
    await expect(h.server.handle(request(h, payload(), { chainId: 43114 }))).rejects.toMatchObject({ code: 'APPROVAL_INVALID', message: 'Intent chainId does not match the transaction' });
    await expect(h.server.handle(request(h, payload(), { routeHash: `0x${'22'.repeat(32)}` }))).rejects.toMatchObject({ code: 'APPROVAL_INVALID', message: 'routeHash does not match the typed data' });
  });
  it('does not let generic typedDataAllow bypass the HL deny', async () => {
    const h = await boot({ explicitAllows: [], chainIds: [43114, 421614], typedDataAllow: [{ domainName: 'HyperliquidSignTransaction', primaryType: TYPE }] });
    await denied(h, request(h), HL_DENY);
  });
  it('leaves non-Hyperliquid typed data on the generic path', async () => {
    const h = await boot({ typedDataAllow: [{ domainName: 'Example', primaryType: 'Example' }] });
    const typed = { domain: { name: 'Example', chainId: 43114 }, types: { Example: [{ name: 'x', type: 'string' }] }, value: { x: 'test' } };
    const result = await h.server.handle(request(h, typed, { venue: 'example', action: 'example' }, 43114));
    expect(verifyTypedData(typed.domain, typed.types, typed.value, result.signature!)).toBe(wallet.address);
    expect(await stored(h)).toBeNull(); expect(h.info).not.toHaveBeenCalled();
  });
  it('starts with missing HL history and retains lastTime after restart', async () => {
    const h = await boot(); expect(await stored(h)).toBeNull();
    const time = Date.now(); await h.server.handle(request(h, payload(time)));
    await h.server.close();
    h.server = await EvalancheSignerServer.create({ ...h.options, initNonces: false }, h.info); servers.push(h.server);
    await denied(h, request(h, payload(time), { nonce: '2' }), 'Hyperliquid withdraw3: time must be greater than the last recorded Hyperliquid nonce');
    expect((await h.server.handle(request(h, payload(time + 1), { nonce: '2' }))).signature).toBeDefined();
  });
  it.each(['{broken', '{}', '{"version":2,"wallets":{}}', '{"version":1,"wallets":[]}', JSON.stringify({ version: 1, wallets: { [wallet.address.toLowerCase()]: { lastTime: 'NaN', used: [] } } })])('refuses corrupt HL history %s', async raw => {
    const h = await boot(); await h.server.close();
    await writeFile(hyperliquidNoncePath(h.options.nonceStorePath), raw);
    await expect(EvalancheSignerServer.create(h.options, h.info)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: 'Hyperliquid nonce store is corrupt' });
  });
  it('keeps only 100 used entries and never lowers lastTime', async () => {
    const h = await boot(); const store = new HyperliquidNonceStore(hyperliquidNoncePath(h.options.nonceStorePath));
    await store.load();
    for (let i = 0; i < 102; i++) await store.record(wallet.address, i);
    const entry = JSON.parse((await stored(h))!).wallets[wallet.address.toLowerCase()];
    expect(entry.used).toHaveLength(100); expect(entry.used[0]).toBe('2'); expect(entry.lastTime).toBe('101');
    await expect(store.record(wallet.address, 100)).rejects.toThrow('time must be greater');
  });
  it('rejects the fetcher as a JSON-config option', async () => {
    const h = await boot(); await h.server.close();
    await expect(EvalancheSignerServer.create({ ...h.options, hyperliquidInfo: 'override' } as SignerServerOptions)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: 'hyperliquidInfo is not a recognized signer setting' });
  });
  it.each(['non-2xx', 'non-JSON'])('fails closed for default transport %s using a local fetch stub', async kind => {
    // Exercise the production transport with a stub; the throwing global fetch is never called.
    const stub = vi.fn(async () => ({ ok: kind !== 'non-2xx', json: async () => { throw new Error('not JSON'); } }));
    vi.stubGlobal('fetch', stub);
    const h = await boot({}, fetchHyperliquidInfo);
    await denied(h, request(h), 'Hyperliquid withdraw3: clearinghouseState read failed');
    expect(stub).toHaveBeenCalledWith('https://api.hyperliquid.xyz/info', expect.objectContaining({ method: 'POST', body: JSON.stringify({ type: 'clearinghouseState', user: wallet.address.toLowerCase() }), headers: { 'content-type': 'application/json' }, signal: expect.any(AbortSignal) }));
  });
});
