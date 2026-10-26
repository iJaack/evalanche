import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intentModule from '../../src/signer/intent';
import {
  LABELS, TIME, base58Decode, decodeBase64, deriveKey, hex, referenceDomainBytes,
  referenceDomainShape, referenceEvmBytes, referenceIntentHash, referenceJcs, referenceRouteHash,
  referenceSchema, referenceSignature, referenceVectorVerdict, referenceVerify, requireFn, vectorApproval,
  type ApprovalVector,
} from './solana-test-helpers';

const raw = readFileSync(new URL('./fixtures/solana-approval-vectors.json', import.meta.url), 'utf8');
const storedFixture = JSON.parse(raw) as { _provenance: { labels: typeof LABELS; purpose: string; derivation: string }; vectors: (Omit<ApprovalVector, 'signerPubkey'> & { signerAddress: string })[] };
// Keep fixture address naming separate from the signing-domain API contract.
const fixture = { ...storedFixture, vectors: storedFixture.vectors.map(({ signerAddress, ...vector }): ApprovalVector => ({ ...vector, signerPubkey: signerAddress })) };
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(TIME + 1000); });
afterEach(() => { vi.restoreAllMocks(); });

describe('shared Solana vectors: independent reference self-consistency (green baseline)', () => {
  it('records test-only public-label provenance and contains no key material', () => {
    expect(fixture._provenance.labels).toEqual(LABELS);
    expect(fixture._provenance.purpose).toMatch(/synthetic/i);
    expect(fixture._provenance.derivation).toContain('sha256(UTF-8(label))');
    for (const label of Object.values(LABELS)) expect(raw).not.toContain(deriveKey(label).seedHex.slice(2));
    function checkKeys(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        expect(key).not.toMatch(/privatekey|secret|apikey|^seed$/i); checkKeys(entry);
      }
    }
    checkKeys(fixture);
  });
  it('has all required attack and boundary cases with unique ids', () => {
    const ids = fixture.vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['valid-mainnet', 'valid-devnet', 'valid-spl-approve', 'dry-run-as-live', 'live-as-dry-run', 'mainnet-as-devnet', 'devnet-as-mainnet', 'treasury-swap', 'deny-as-approve', 'approve-as-deny', 'mutated-message', 'nul-cluster', 'nul-pubkey', 'base58-case-variant', 'evm-baseline', 'slippage-100', 'slippage-101', 'decimals-255', 'decimals-256', 'nonce-0', 'nonce-00', 'u64-max', 'extra-intent', 'extra-tx', 'extra-tokenIn']) expect(ids).toContain(id);
    expect(fixture.vectors.find((v) => v.id === 'valid-mainnet')!.expected).toEqual({ valid: true });
    expect(fixture.vectors.find((v) => v.id === 'slippage-101')!.expected).toEqual({ valid: false, error: 'schema' });
  });
  it('re-derives public treasury identities and validates the synthetic message structure only', () => {
    const a = deriveKey(LABELS.treasuryA), b = deriveKey(LABELS.treasuryB);
    expect(a.raw).toHaveLength(32); expect(b.raw).toHaveLength(32); expect(a.pubkey).not.toBe(b.pubkey);
    expect(base58Decode(a.pubkey)).toEqual(a.raw);
    const mainnet = fixture.vectors.find((v) => v.id === 'valid-mainnet')!;
    expect(mainnet.signerPubkey).toBe(a.pubkey);
    expect(fixture.vectors.find((v) => v.id === 'treasury-swap')!.signerPubkey).toBe(b.pubkey);
    const message = decodeBase64(mainnet.base64Message);
    expect([...message.subarray(0, 5)]).toEqual([0x80, 1, 0, 1, 2]);
    expect(message.subarray(5, 37)).toEqual(a.raw);
    expect(message.at(-1)).toBe(0); // zero ALTs; no production parser or semantic claim
  });
  it.each(fixture.vectors)('$id: independent JCS, hashes, bytes, Ed25519 and verdict', (vector) => {
    expect(vector.normalizedJcs).toBe(referenceJcs(vector.structuredIntent));
    expect(vector.normalizedJcs).toBe(requireFn(intentModule, 'canonicalJson')(vector.structuredIntent));
    expect(vector.intentHash).toBe(referenceIntentHash(vector.structuredIntent));
    expect(vector.verifier).toBe(deriveKey(LABELS.verifier).publicHex);
    expect(vector.verifier).toMatch(/^0x[0-9a-f]{64}$/);
    expect(vector.signature).toMatch(/^0x[0-9a-f]{128}$/);
    if (vector.family === 'evm') {
      const bytes = referenceEvmBytes({ ...vector, signerAddress: vector.signerPubkey, chainId: vector.structuredIntent.chainId });
      expect(vector.domainBytesHex).toBe(hex(bytes));
      expect(referenceVerify(bytes, vector.signature, vector.verifier)).toBe(true);
      expect(vector.routeHash).toBe(vector.structuredIntent.routeHash);
    } else {
      expect(vector.base64Message).toBe(vector.structuredIntent.tx.serializedMessage);
      expect(vector.routeHash).toBe(referenceRouteHash(vector.base64Message));
      expect(vector.routeHash).toBe(vector.structuredIntent.routeHash);
      expect(vector.domainBytesHex).toBe(hex(referenceDomainBytes(vector)));
      if (vector.expected.valid) {
        expect(referenceVerify(referenceDomainBytes(vector), vector.signature, vector.verifier)).toBe(true);
        expect(vector.signature).toBe(referenceSignature(referenceDomainBytes(vector)));
      }
    }
    expect(referenceVectorVerdict(vector)).toEqual(vector.expected);
  });
});

describe('shared Solana vectors: production contract (PR1 red phase)', () => {
  it.each(fixture.vectors)('$id: production reproduces fields and verdict', (vector) => {
    const hash = requireFn(intentModule, 'computeIntentHash');
    if (vector.family === 'evm') {
      expect(hash(vector.structuredIntent)).toBe(vector.intentHash);
      const bytes = requireFn(intentModule, 'approvalSigningBytes')({ ...vector, signerAddress: vector.signerPubkey, chainId: vector.structuredIntent.chainId });
      expect(hex(bytes)).toBe(vector.domainBytesHex);
      expect(requireFn(intentModule, 'verifyBytes')(bytes, vector.signature, vector.verifier)).toBe(true);
      return;
    }
    // Look up inside each test, before expect(...).toThrow(), so missing exports
    // are explicit red failures rather than accidentally satisfying a denial.
    const schema = requireFn(intentModule, 'assertSolanaIntentShape');
    const route = requireFn(intentModule, 'computeSolanaRouteHash');
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    expect(route(vector.base64Message)).toBe(vector.routeHash);
    if (vector.expected.error === 'schema') {
      expect(() => schema(vector.structuredIntent)).toThrow();
      expect(() => hash(vector.structuredIntent)).toThrow();
    } else {
      expect(schema(vector.structuredIntent)).toEqual(referenceSchema(vector.structuredIntent));
      expect(requireFn(intentModule, 'canonicalJson')(schema(vector.structuredIntent))).toBe(vector.normalizedJcs);
      expect(hash(vector.structuredIntent)).toBe(vector.intentHash);
    }
    if (vector.expected.error === 'domain') {
      expect(() => referenceDomainShape(vector)).toThrow();
      expect(() => bytes(vector)).toThrow();
    } else {
      expect(hex(bytes(vector))).toBe(vector.domainBytesHex);
    }
    expect(verify({ intent: vector.structuredIntent, approval: vectorApproval(vector), mode: vector.mode, verifierPublicKey: vector.verifier })).toBe(vector.expected.valid);
    if (vector.expected.valid) {
      const key = deriveKey(LABELS.verifier);
      const sign = requireFn(intentModule, 'signSolanaVerifierApproval');
      expect(sign({ intent: vector.structuredIntent, verifierPrivateKey: key.seedHex, verifierPublicKey: key.publicHex,
        decision: vector.decision, mode: vector.mode, signerAddress: vector.signerPubkey })).toEqual(vectorApproval(vector));
    }
  });
});
