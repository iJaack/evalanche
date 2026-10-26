import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intentModule from '../../src/signer/intent';
import {
  CLUSTERS, DOMAIN, LABELS, TIME, caseFlip, deriveKey, hex, makeEvmIntent, makeIntent,
  referenceApproval, referenceDomainBytes, referenceIntentHash, referenceSignature, requireFn, withMessage,
} from './solana-test-helpers';

const EVM_BYTES = '0x6576616c616e6368652d76657269666965722f763100617070726f7665006c697665003078313131313131313131313131313131313131313131313131313131313131313131313131313131310034333131340091eabb24e67e5743788ce220b7d2250be37bac4b71afb5722e7cda9519b862f4';
function args() {
  const intent = makeIntent();
  return { decision: 'approve', mode: 'live', signerPubkey: intent.wallet, cluster: intent.chainId, intentHash: referenceIntentHash(intent) };
}
function verifyArgs(intent = makeIntent(), mode = 'live') {
  return { intent, approval: referenceApproval(intent, mode), mode, verifierPublicKey: deriveKey(LABELS.verifier).publicHex };
}
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(TIME + 1000); });
afterEach(() => { vi.restoreAllMocks(); });

describe('PR1 approval bytes', () => {
  it('exports the exact NUL-terminated Solana domain', () => {
    expect(intentModule).toHaveProperty('SOLANA_APPROVAL_DOMAIN', DOMAIN);
  });
  it('freezes the existing EVM approval bytes and EVM domain', () => {
    const intent = makeEvmIntent();
    const bytes = requireFn(intentModule, 'approvalSigningBytes')({ decision: 'approve', mode: 'live', signerAddress: intent.wallet, chainId: intent.chainId, intentHash: referenceIntentHash(intent) });
    expect(hex(bytes)).toBe(EVM_BYTES);
    expect(Buffer.from(bytes).subarray(0, 22).toString()).toBe('evalanche-verifier/v1\0');
  });
  it.each(CLUSTERS)('matches the independent byte layout for %s', (cluster) => {
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    const input = { ...args(), cluster };
    expect(Buffer.from(bytes(input))).toEqual(referenceDomainBytes(input));
    expect(hex(bytes(input)).slice(-64)).toBe(input.intentHash.slice(2));
  });
  it.each(['decision', 'mode', 'signerPubkey', 'cluster', 'intentHash'])('rejects embedded NUL in %s', (field) => {
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    const input = args(); expect(() => bytes({ ...input, [field]: input[field as keyof typeof input] + '\0' })).toThrow();
  });
  it.each([
    ['decision', 'allow'], ['decision', 'Approve'], ['mode', 'LIVE'], ['mode', 'simulation'],
    ['cluster', 'solana:testnet'], ['cluster', 'Solana:mainnet'], ['cluster', '43114'],
    ['signerPubkey', '0OIl'], ['signerPubkey', '1111'], ['signerPubkey', ' ' + makeIntent().wallet],
    ['intentHash', '0x' + '00'.repeat(31)], ['intentHash', '0x' + '00'.repeat(33)], ['intentHash', '0x' + 'gg'.repeat(32)],
  ])('rejects malformed %s=%j', (field, value) => {
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    expect(() => bytes({ ...args(), [field]: value })).toThrow();
  });
  it('preserves base58 case in approval bytes', () => {
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    const input = args(); const variant = { ...input, signerPubkey: caseFlip(input.signerPubkey) };
    expect(Buffer.from(bytes(input))).toEqual(referenceDomainBytes(input));
    expect(Buffer.from(bytes(variant))).toEqual(referenceDomainBytes(variant));
    expect(hex(bytes(input))).not.toBe(hex(bytes(variant)));
  });
});

describe('PR1 Solana approval signing and verification', () => {
  it('signs the exact reference approval with live/approve defaults', () => {
    const sign = requireFn(intentModule, 'signSolanaVerifierApproval');
    const intent = makeIntent(); const verifier = deriveKey(LABELS.verifier);
    const approval = sign({ intent, verifierPrivateKey: verifier.seedHex, verifierPublicKey: verifier.publicHex });
    expect(approval).toEqual(referenceApproval(intent));
    expect(requireFn(intentModule, 'verifySolanaApproval')({ intent, approval, mode: 'live', verifierPublicKey: verifier.publicHex })).toBe(true);
  });
  it.each(['live', 'dry-run'])('signs explicitly selected %s bytes', (mode) => {
    const sign = requireFn(intentModule, 'signSolanaVerifierApproval');
    const intent = makeIntent(); const verifier = deriveKey(LABELS.verifier);
    expect(sign({ intent, verifierPrivateKey: verifier.seedHex, verifierPublicKey: verifier.publicHex, mode, decision: 'approve', signerAddress: intent.wallet })).toEqual(referenceApproval(intent, mode));
  });
  it.each(CLUSTERS)('accepts only approve with bound nonce and expiry on %s', (cluster) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    expect(verify(verifyArgs(makeIntent('swap', cluster)))).toBe(true);
  });
  it.each(['mode', 'cluster', 'treasury', 'decision', 'message', 'nonce', 'expiry', 'hash', 'verifier', 'signature', 'case', 'null'])('rejects %s substitution', (attack) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs();
    if (attack === 'mode') input.mode = 'dry-run';
    if (attack === 'cluster') input.intent.chainId = 'solana:devnet';
    if (attack === 'treasury') input.intent.wallet = deriveKey(LABELS.treasuryB).pubkey;
    if (attack === 'decision') input.approval = referenceApproval(input.intent, 'live', 'deny');
    if (attack === 'message') input.intent = withMessage(input.intent, 'approval-mutation');
    if (attack === 'nonce') input.approval.nonce = '2';
    if (attack === 'expiry') input.approval.expiresAt += 1;
    if (attack === 'hash') input.approval.intentHash = '0x' + '00'.repeat(32);
    if (attack === 'verifier') input.verifierPublicKey = deriveKey('evalanche-test-only/other-verifier').publicHex;
    if (attack === 'signature') input.approval.signature = '0x' + '00'.repeat(64);
    if (attack === 'case') input.approval.signerAddress = caseFlip(input.approval.signerAddress);
    if (attack === 'null') input.approval = null as any;
    expect(verify(input)).toBe(false);
  });
  it.each(['dry-run', 'live'])('rejects opposite mode signature presented as %s', (mode) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs(makeIntent(), mode); input.approval = referenceApproval(input.intent, mode === 'live' ? 'dry-run' : 'live');
    input.approval.mode = mode;
    expect(verify(input)).toBe(false);
  });
  it('rejects a forged verifier field even with a signature from the pinned key', () => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs(); input.approval.verifier = deriveKey('evalanche-test-only/other-verifier').publicHex;
    expect(verify(input)).toBe(false);
  });
  it.each(['nonce', 'expiresAt'])('does not coerce approval %s to match intent', (field) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs(); input.approval[field] = field === 'nonce' ? 1 : String(input.intent.expiresAt);
    expect(verify(input)).toBe(false);
  });
  it.each(['cluster', 'treasury', 'decision', 'message'])('rejects %s even if presented intentHash is recomputed', (attack) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs();
    if (attack === 'cluster') input.intent.chainId = 'solana:devnet';
    if (attack === 'treasury') { input.intent.wallet = deriveKey(LABELS.treasuryB).pubkey; input.approval.signerAddress = input.intent.wallet; }
    if (attack === 'decision') input.approval.signature = referenceApproval(input.intent, 'live', 'deny').signature;
    if (attack === 'message') input.intent = withMessage(input.intent, 'rehash-mutation');
    input.approval.intentHash = referenceIntentHash(input.intent);
    expect(verify(input)).toBe(false);
  });
  it.each([1, 43114, 137, Number.MAX_SAFE_INTEGER])('never verifies Solana bytes as EVM on chain %s, even for the identical intentHash', (chainId) => {
    const solBytes = requireFn(intentModule, 'solanaApprovalSigningBytes');
    const evmBytes = requireFn(intentModule, 'approvalSigningBytes');
    const verify = requireFn(intentModule, 'verifyBytes');
    const input = args(); const signature = referenceSignature(solBytes(input));
    const bytes = evmBytes({ decision: input.decision, mode: input.mode, signerAddress: makeEvmIntent().wallet, chainId, intentHash: input.intentHash });
    expect(verify(bytes, signature, deriveKey(LABELS.verifier).publicHex)).toBe(false);
  });
  it.each([1, 43114, 137, Number.MAX_SAFE_INTEGER])('never verifies EVM bytes as Solana on EVM chain %s with identical hash', (chainId) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const evmBytes = requireFn(intentModule, 'approvalSigningBytes');
    const input = verifyArgs();
    input.approval.signature = referenceSignature(evmBytes({ decision: 'approve', mode: 'live', signerAddress: makeEvmIntent().wallet, chainId, intentHash: input.approval.intentHash }));
    expect(verify(input)).toBe(false);
  });
  it('binds mainnet/devnet domains independently of whether a hash happens to be identical', () => {
    const bytes = requireFn(intentModule, 'solanaApprovalSigningBytes'); const verify = requireFn(intentModule, 'verifyBytes');
    const input = args(); const signature = referenceSignature(bytes(input));
    expect(verify(bytes({ ...input, cluster: 'solana:devnet' }), signature, deriveKey(LABELS.verifier).publicHex)).toBe(false);
  });
});

describe('PR1 malformed approval rejection', () => {
  it.each(['decision', 'mode', 'signerAddress', 'intentHash', 'verifier', 'signature'])('fails closed for NUL in approval.%s', (field) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs(); input.approval[field] += '\0'; expect(verify(input)).toBe(false);
  });
  it.each(['short-key', 'small-order-key', 'short-signature', 'noncanonical-signature', 'invalid-decision', 'invalid-mode'])('fails closed for %s', (attack) => {
    const verify = requireFn(intentModule, 'verifySolanaApproval');
    const input = verifyArgs();
    if (attack === 'short-key') input.verifierPublicKey = '0x12';
    if (attack === 'small-order-key') {
      input.verifierPublicKey = '0x01' + '00'.repeat(31); input.approval.verifier = input.verifierPublicKey;
      input.approval.signature = '0x01' + '00'.repeat(63);
    }
    if (attack === 'short-signature') input.approval.signature = '0x12';
    if (attack === 'noncanonical-signature') input.approval.signature = '0x' + 'ff'.repeat(64);
    if (attack === 'invalid-decision') input.approval.decision = 'allow';
    if (attack === 'invalid-mode') input.mode = input.approval.mode = 'LIVE';
    expect(verify(input)).toBe(false);
  });
});
