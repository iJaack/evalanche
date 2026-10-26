import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as intentModule from '../../src/signer/intent';
import * as publicModule from '../../src/index';
import { LABELS, deriveKey, makeIntent, makeRequest, requireFn, syntheticMessage } from './solana-test-helpers';
import {
  encodeMessage, instruction, key, messageIntent, messageParts,
  messageSpec, offsetOf, replacePart, routeHash, shortvec, SYSTEM,
} from './solana-message-helpers';

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 message test: fetch forbidden'); });
  vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => { try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });

describe('PR2 independent fixture self-checks (green baseline)', () => {
  it.each([[0, [0]], [127, [127]], [128, [128, 1]], [16383, [255, 127]], [16384, [128, 128, 1]], [65535, [255, 255, 3]]])('encodes compact-u16 %i', (value, bytes) => {
    expect([...shortvec(value as number)]).toEqual(bytes);
  });
  it('reproduces the old PR1 opaque message byte-for-byte without its encoder', () => {
    const spec = messageSpec(); spec.header = [1, 0, 1]; spec.keys = spec.keys.slice(0, 2);
    spec.blockhash = makeIntent().tx.recentBlockhash;
    spec.instructions = [instruction(Buffer.from([2, 224, 147, 4, 0]))];
    expect(encodeMessage(spec)).toEqual(syntheticMessage());
  });
  it('builds schema-valid message-bound intents using the independent SHA-256 oracle', () => {
    const intent = messageIntent();
    expect(requireFn(intentModule, 'assertSolanaIntentShape')(intent)).toEqual(intent);
    expect(intent.routeHash).toBe(routeHash(encodeMessage()));
  });
  it.each(['assertSolanaIntentShape', 'assertIntentShape', 'assertSolanaRequestShape'])('preserves PR1 %s acceptance without CU price or wire payer matching', (name) => {
    const intent = makeIntent(); intent.wallet = deriveKey(LABELS.treasuryB).pubkey;
    const input = name === 'assertSolanaRequestShape' ? makeRequest(intent) : intent;
    expect(requireFn(intentModule, name)(input)).toEqual(input);
  });
});

describe('PR2 strict static-key v0 parser', () => {
  it.each(['base64', 'Uint8Array'])('decodes the complete %s message shape and preserves route bytes', (form) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage');
    const spec = messageSpec(); const bytes = encodeMessage(spec);
    const input = form === 'base64' ? bytes.toString('base64') : new Uint8Array(bytes);
    expect(parse(input)).toEqual({
      version: 0, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
      staticAccountKeys: spec.keys, recentBlockhash: spec.blockhash,
      instructions: spec.instructions.map((ix) => ({ ...ix, data: new Uint8Array(ix.data), programId: spec.keys[ix.programIdIndex] })),
      addressTableLookups: [],
    });
    expect(requireFn(intentModule, 'computeSolanaRouteHash')(bytes.toString('base64'))).toBe(routeHash(bytes));
  });
  it('handles Uint8Array views using their offset and byteLength', () => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const bytes = encodeMessage();
    const padded = Buffer.concat([Buffer.from([0xff]), bytes, Buffer.from([0xff])]);
    expect(parse(new Uint8Array(padded.buffer, padded.byteOffset + 1, bytes.length))).toEqual(parse(bytes));
  });
  it('accepts canonical multi-byte counts and data lengths', () => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec();
    spec.keys.push(...Array.from({ length: 125 }, (_, i) => key(`static-${i}`)));
    spec.instructions = Array.from({ length: 128 }, () => instruction(Buffer.alloc(128, 7), 1, [127]));
    const parsed = parse(encodeMessage(spec));
    expect(parsed.staticAccountKeys).toEqual(spec.keys); expect(parsed.instructions).toHaveLength(128);
    expect(parsed.instructions[127].accountIndices).toEqual([127]); expect(parsed.instructions[127].data).toEqual(new Uint8Array(128).fill(7));
  });
  it('allows zero instructions and zero readonly unsigned accounts at parser level', () => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec();
    spec.header[2] = 0; spec.instructions = [];
    expect(parse(encodeMessage(spec)).instructions).toEqual([]);
  });
  it.each(['', 'gA', 'gB==', 'gA===', 'gA==\n', ' gA==', '-A==', '_A==', '!!!!'])('rejects empty/noncanonical base64 %j', (input) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); expect(() => parse(input)).toThrow();
  });
  it.each(['missing padding', 'newline', 'leading space', 'extra padding', 'URL alphabet', 'nonzero padding bits'])('rejects noncanonical base64 of an otherwise valid message: %s', (variant) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const canonical = encodeMessage().toString('base64');
    const mutated = variant === 'missing padding' ? canonical.replace(/=+$/, '')
      : variant === 'newline' ? canonical + '\n' : variant === 'leading space' ? ' ' + canonical
        : variant === 'extra padding' ? canonical + '=' : variant === 'URL alphabet' ? canonical.replace(/\+/g, '-').replace(/\//g, '_')
          : canonical.slice(0, -3) + 'B==';
    expect(mutated).not.toBe(canonical);
    expect(Buffer.from(mutated, 'base64')).toEqual(encodeMessage());
    expect(() => parse(mutated)).toThrow();
  });
  it('rejects empty byte input', () => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); expect(() => parse(new Uint8Array())).toThrow();
  });
  it.each([0, 1, 0x7f, 0x81, 0xff])('rejects legacy/unsupported version byte %i', (version) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec(); spec.version = version;
    expect(() => parse(encodeMessage(spec))).toThrow();
  });
  // Every required wire stage has a targeted cut, without hundreds of identical byte-cut cases.
  it.each([
    ['header', 'header', 2], ['key count', 'keyCount', 0], ['keys', 'keys', 31],
    ['blockhash', 'blockhash', 31], ['instruction count', 'instructionCount', 0],
    ['program index', 'ix0.program', 0], ['account count', 'ix2.accountCount', 0],
    ['account list', 'ix2.accounts', 0], ['data length', 'ix0.dataLength', 0],
    ['data', 'ix0.data', 4], ['ALT count', 'lookupCount', 0],
  ])('rejects truncation at %s', (_name, part, kept) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage');
    expect(() => parse(encodeMessage().subarray(0, offsetOf(part) + Number(kept)))).toThrow();
  });
  it.each(['keyCount', 'instructionCount', 'ix0.accountCount', 'ix0.dataLength', 'lookupCount'])('rejects overlong compact-u16 at %s', (part) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage');
    const value = messageParts().find(([name]) => name === part)![1][0];
    expect(() => parse(replacePart(part, [value | 0x80, 0]))).toThrow();
  });
  it.each([[0x80, 0x80, 0], [0xff, 0xff, 4], [0x80, 0x80, 0x80, 0], [0x80]].map((bytes) => [bytes]))('rejects malformed/overflow compact-u16 %j', (bytes) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); expect(() => parse(replacePart('keyCount', bytes))).toThrow();
  });
  it.each([
    ['zero keys', (s: ReturnType<typeof messageSpec>) => { s.keys = []; s.instructions = []; s.header[2] = 0; }],
    ['duplicate keys', (s: ReturnType<typeof messageSpec>) => { s.keys[2] = s.keys[1]; }],
    ['program index equal to count', (s: ReturnType<typeof messageSpec>) => { s.instructions[0].programIdIndex = s.keys.length; }],
    ['program index above count', (s: ReturnType<typeof messageSpec>) => { s.instructions[0].programIdIndex = 255; }],
    ['payer used as program', (s: ReturnType<typeof messageSpec>) => { s.instructions[0].programIdIndex = 0; }],
    ['account index equal to count', (s: ReturnType<typeof messageSpec>) => { s.instructions[2].accountIndices = [s.keys.length]; }],
    ['account index above count', (s: ReturnType<typeof messageSpec>) => { s.instructions[2].accountIndices = [255]; }],
    ['no signer', (s: ReturnType<typeof messageSpec>) => { s.header[0] = 0; }],
    ['extra signer', (s: ReturnType<typeof messageSpec>) => { s.header = [2, 0, 1]; }],
    ['signers exceed keys', (s: ReturnType<typeof messageSpec>) => { s.header = [4, 0, 0]; }],
    ['readonly payer', (s: ReturnType<typeof messageSpec>) => { s.header[1] = 1; }],
    ['readonly signed exceeds signers', (s: ReturnType<typeof messageSpec>) => { s.header[1] = 2; }],
    ['readonly unsigned exceeds unsigned count', (s: ReturnType<typeof messageSpec>) => { s.header[2] = 3; }],
  ] as const)('rejects %s', (_name, mutate) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec(); mutate(spec);
    expect(() => parse(encodeMessage(spec))).toThrow();
  });
  it.each([[0], [1, 2, 3]].map((bytes) => [bytes]))('rejects trailing bytes %j after ALT section', (extra) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); expect(() => parse(Buffer.concat([encodeMessage(), Buffer.from(extra)]))).toThrow();
  });
  it.each(['writable', 'readonly', 'empty'] as const)('parses then denies a well-formed %s lookup with an ALT-specific error', (kind) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec();
    spec.lookups = [{ accountKey: key('lookup-table'), writable: kind === 'writable' ? [1] : [], readonly: kind === 'readonly' ? [2] : [] }];
    expect(() => parse(encodeMessage(spec))).toThrow(/lookup|ALT|address table/i);
  });
  it.each(['alt0.key', 'alt0.writableCount', 'alt0.writable', 'alt0.readonlyCount', 'alt0.readonly'])('distinguishes truncated %s from a fully parsed denied lookup', (part) => {
    const parse = requireFn(intentModule, 'parseSolanaMessage'); const spec = messageSpec();
    spec.lookups = [{ accountKey: key('lookup-table'), writable: [1], readonly: [2] }];
    expect(() => parse(encodeMessage(spec).subarray(0, offsetOf(part, spec)))).toThrow(/truncat|short|end|length|bounds|incomplete/i);
  });
});

describe('PR2 intent-to-message binding', () => {
  it('returns the parsed message after every binding check', () => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent');
    expect(match(messageIntent())).toEqual(requireFn(intentModule, 'parseSolanaMessage')(encodeMessage()));
  });
  it.each(['schema', 'hash', 'blockhash', 'payer', 'durable', 'extra signer', 'zero payer'])('denies %s mismatch independently of schema-only acceptance', (attack) => {
    const match = requireFn(intentModule, 'assertSolanaMessageMatchesIntent'); const spec = messageSpec();
    if (attack === 'extra signer') spec.header = [2, 0, 1];
    if (attack === 'zero payer') spec.keys[0] = SYSTEM;
    const intent = messageIntent(spec);
    if (attack === 'schema') intent.unknown = true;
    if (attack === 'hash') intent.routeHash = '0x' + '00'.repeat(32);
    if (attack === 'blockhash') intent.tx.recentBlockhash = key('other-blockhash');
    if (attack === 'payer') intent.wallet = deriveKey(LABELS.treasuryB).pubkey;
    if (attack === 'durable') {
      delete intent.tx.recentBlockhash; delete intent.tx.lastValidBlockHeight;
      intent.tx.durableNonce = { nonceAccount: key('nonce-account'), nonceAuthority: intent.wallet, nonceValue: spec.blockhash };
    }
    expect(() => match(intent)).toThrow();
  });
  it.each(['parseSolanaMessage', 'assertSolanaMessageMatchesIntent', 'solanaPriorityFeeLamports'])('re-exports %s through the signer barrel and public index', (name) => {
    const fn = requireFn(intentModule, name); expect(requireFn(publicModule, name)).toBe(fn);
  });
});
