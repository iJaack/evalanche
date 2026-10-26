import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import * as intentModule from '../../src/signer/intent';
import * as publicModule from '../../src/index';
import { DOMAIN, CLUSTERS, clone, makeEvmIntent, makeIntent, referenceJcs, requireFn, syntheticMessage, withMessage } from './solana-test-helpers';

const EVM_BASELINE_HASH = '0x91eabb24e67e5743788ce220b7d2250be37bac4b71afb5722e7cda9519b862f4';

describe('PR1 intent and message hash contracts', () => {
  it('freezes the existing EVM intent hash', () => {
    expect(requireFn(intentModule, 'computeIntentHash')(makeEvmIntent())).toBe(EVM_BASELINE_HASH);
  });
  it('hashes normalized Solana JCS with keccak256 UTF-8, not SHA-256', () => {
    const intent = makeIntent();
    const expected = keccak256(toUtf8Bytes(requireFn(intentModule, 'canonicalJson')(intent)));
    expect(requireFn(intentModule, 'canonicalJson')(intent)).toBe(referenceJcs(intent));
    const hash = requireFn(intentModule, 'computeIntentHash');
    expect(() => hash(intent)).not.toThrow();
    expect(hash(intent)).toBe(expected);
  });
  it('normalizes NFC display strings without changing case-sensitive pubkeys', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const hash = requireFn(intentModule, 'computeIntentHash');
    const intent = makeIntent(); intent.intentId = 'cafe\u0301'; intent.tokenIn.symbol = 'e\u0301'; intent.quoteId = 'route-e\u0301';
    const normalized = validate(intent);
    expect(normalized.intentId).toBe('café'); expect(normalized.tokenIn.symbol).toBe('é');
    expect(normalized.wallet).toBe(intent.wallet);
    expect(hash(intent)).toBe(keccak256(toUtf8Bytes(requireFn(intentModule, 'canonicalJson')(normalized))));
    expect(hash(intent)).toBe(hash(normalized));
  });
  it('is independent of object insertion order at every depth', () => {
    const hash = requireFn(intentModule, 'computeIntentHash');
    const intent = makeIntent(); const reversed = Object.fromEntries(Object.entries(intent).reverse());
    reversed.tx = Object.fromEntries(Object.entries(intent.tx).reverse());
    expect(() => hash(reversed)).not.toThrow();
    expect(hash(reversed)).toBe(hash(intent));
  });
  it.each(['nonce', 'chainId', 'wallet', 'amountIn', 'programIds', 'tx'])('hash-binds %s', (field) => {
    const hash = requireFn(intentModule, 'computeIntentHash');
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); const changed = clone(intent);
    if (field === 'nonce') changed.nonce = '2';
    if (field === 'chainId') changed.chainId = 'solana:devnet';
    if (field === 'wallet') changed.wallet = intent.tokenIn.mint;
    if (field === 'amountIn') changed.amountIn = '100000001';
    if (field === 'programIds') changed.programIds = [intent.programIds[0]];
    if (field === 'tx') changed.tx.computeUnitPriceMicroLamports = '1000001';
    validate(changed);
    expect(() => hash(changed)).not.toThrow();
    expect(hash(changed)).not.toBe(hash(intent));
  });
  it('binds a mutated message through a different routeHash and intentHash', () => {
    const hash = requireFn(intentModule, 'computeIntentHash');
    const intent = makeIntent(); const changed = withMessage(intent, 'mutated');
    expect(changed.routeHash).not.toBe(intent.routeHash);
    expect(() => hash(changed)).not.toThrow();
    expect(hash(changed)).not.toBe(hash(intent));
  });
  it('uses SHA-256 over decoded bytes for both input forms', () => {
    const routeHash = requireFn(intentModule, 'computeSolanaRouteHash');
    const bytes = syntheticMessage(); const base64 = bytes.toString('base64');
    const expected = '0x' + createHash('sha256').update(bytes).digest('hex');
    expect(routeHash(base64)).toBe(expected);
    expect(routeHash(new Uint8Array(bytes))).toBe(expected);
    expect(expected).toMatch(/^0x[0-9a-f]{64}$/);
    expect(expected).not.toBe(keccak256(bytes));
    expect(expected).not.toBe('0x' + createHash('sha256').update(base64, 'utf8').digest('hex'));
  });
  it.each(['gA', 'gA==\n', ' gA==', '-A==', '_A==', 'gB==', 'gA===', '!', ''])('rejects noncanonical route input %j', (value) => {
    const routeHash = requireFn(intentModule, 'computeSolanaRouteHash');
    expect(() => routeHash(value)).toThrow();
  });
  it('exposes Solana constants at the public package entry point', () => {
    expect(publicModule).toHaveProperty('SOLANA_APPROVAL_DOMAIN', DOMAIN);
    expect(publicModule).toHaveProperty('SOLANA_CLUSTERS', CLUSTERS);
  });
  it.each(['isSolanaChainId', 'assertSolanaIntentShape', 'assertIntentShape', 'assertSolanaRequestShape', 'computeIntentHash', 'computeSolanaRouteHash', 'solanaApprovalSigningBytes', 'signSolanaVerifierApproval', 'verifySolanaApproval'])('re-exports %s through the signer barrel and src/index', (name) => {
    // src/index imports its signer exports from ./signer, exercising that barrel too.
    const exported = requireFn(publicModule, name);
    expect(exported).toBe(requireFn(intentModule, name));
  });
});
