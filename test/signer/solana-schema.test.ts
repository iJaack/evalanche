import { describe, expect, it } from 'vitest';
import { keccak256 } from 'ethers';
import * as intentModule from '../../src/signer/intent';
import {
  CLUSTERS, LABELS, SWAP_FIELDS, base58Encode, caseFlip, clone, deriveKey, durableIntent,
  makeEvmIntent, makeIntent, makeRequest, referenceApproval, referenceRouteHash, requireFn, sha256,
} from './solana-test-helpers';

describe('PR1 Solana chain dispatch and request envelope', () => {
  it('exports the exact case-sensitive cluster enum', () => {
    expect(intentModule).toHaveProperty('SOLANA_CLUSTERS', CLUSTERS);
  });
  it.each([
    ['solana:mainnet', true], ['solana:devnet', true], [43114, false], [1, false],
    ['43114', false], ['1', false], ['solana:testnet', false], ['Solana:mainnet', false],
    ['solana:mainnet\0', false], [null, false], [undefined, false], [{}, false],
  ])('isSolanaChainId(%j) is %s', (value, expected) => {
    expect(requireFn(intentModule, 'isSolanaChainId')(value)).toBe(expected);
  });
  it.each(CLUSTERS)('dispatches assertIntentShape to the %s schema', (cluster) => {
    const solana = requireFn(intentModule, 'assertSolanaIntentShape');
    const dispatch = requireFn(intentModule, 'assertIntentShape');
    const intent = makeIntent('swap', cluster);
    expect(dispatch(intent)).toEqual(solana(intent));
  });
  it('preserves the EVM integer schema and transaction fields', () => {
    const intent = makeEvmIntent();
    expect(requireFn(intentModule, 'assertIntentShape')(intent)).toEqual(intent);
  });
  it.each(['43114', '1', 'solana:testnet', 'Solana:mainnet', 'solana:mainnet\0'])('rejects chainId %j without numeric coercion', (chainId) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(() => validate({ ...makeIntent(), chainId })).toThrow();
    expect(() => requireFn(intentModule, 'assertIntentShape')({ ...makeIntent(), chainId })).toThrow();
  });
  it('accepts a complete proposal with approval null and no EVM aliases', () => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    expect(() => validate(makeRequest())).not.toThrow();
  });
  it('accepts an exact approval object at request level', () => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); request.approval = referenceApproval(request.structuredIntent);
    expect(() => validate(request)).not.toThrow();
  });
  it.each(['to', 'data', 'value', 'gasLimit', 'nonce', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type', 'message', 'typedData'])('rejects outer EVM field %s even when empty', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    expect(() => validate({ ...makeRequest(), [field]: field === 'typedData' ? {} : '' })).toThrow();
  });
  it.each(['requestId', 'kind', 'chainId', 'from', 'intent', 'structuredIntent', 'approval'])('requires request field %s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); delete request[field];
    expect(() => validate(request)).toThrow();
  });
  it.each([
    ['requestId', ''], ['intent', ''], ['kind', 'message'], ['kind', 'typed-data'],
    ['from', '0x1111111111111111111111111111111111111111'],
    ['from', deriveKey(LABELS.treasuryB).pubkey], ['chainId', 'solana:devnet'],
  ])('rejects request mismatch %s=%j', (field, value) => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    expect(() => validate({ ...makeRequest(), [field]: value })).toThrow();
  });
});

describe('PR1 exact Solana structured intent', () => {
  it.each(['swap', 'approve', 'revoke', 'transfer'])('accepts the exact %s key set', (action) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(action);
    expect(validate(intent)).toEqual(intent);
  });
  it('accepts the system transfer venue', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent('transfer'); intent.venue = 'system'; intent.tokenIn = { mint: makeIntent().tokenOut.mint, symbol: 'SOL', decimals: 9 };
    expect(validate(intent)).toEqual(intent);
  });
  it.each(Object.keys(makeIntent()))('requires swap field %s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); delete intent[field];
    expect(() => validate(intent)).toThrow();
  });
  it.each(['bridge', 'lifi', 'Swap', 'polymarket', 'send', ''])('rejects action %j', (action) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(() => validate({ ...makeIntent(), action })).toThrow();
  });
  it.each([['swap', 'spl-token'], ['swap', 'system'], ['approve', 'jupiter-v6'], ['approve', 'system'], ['revoke', 'jupiter-v6'], ['transfer', 'jupiter-v6'], ['swap', 'unknown']])('rejects action/venue %s/%s', (action, venue) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(() => validate({ ...makeIntent(action), venue })).toThrow();
  });
  it.each(['tier', 'sleeve', 'polymarket', 'clmm', 'signalRefs', 'sizePctOfTreasury', 'postFrictionEvUsd', 'to', 'data', 'value', 'delegate', 'unexpected'])('rejects EVM-only or unknown intent field %s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(() => validate({ ...makeIntent(), [field]: 'forbidden' })).toThrow();
  });
  for (const action of ['approve', 'revoke', 'transfer']) {
    it.each(SWAP_FIELDS)('rejects swap-only %s on ' + action, (field) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      expect(() => validate({ ...makeIntent(action), [field]: makeIntent()[field] })).toThrow();
    });
  }
  it.each(['version', 'intentId', 'quoteId'])('rejects invalid string field %s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    for (const value of ['', 1, null, ...(field === 'version' ? ['2'] : [])]) expect(() => validate({ ...makeIntent(), [field]: value })).toThrow();
  });
  for (const field of ['nonce', 'amountIn', 'minAmountOut', 'quotedAmountOut']) {
    it.each(['01', '-1', '1e3', '1.5', 1, '', '+1'])('rejects noncanonical ' + field + ' %j', (value) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      expect(() => validate({ ...makeIntent(), [field]: value })).toThrow();
    });
  }
  it('accepts canonical zero nonce and u64 max schema amount', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = { ...makeIntent(), nonce: '0', amountIn: '18446744073709551615' };
    expect(validate(intent)).toEqual(intent);
  });
  it('requires revoke amountIn exactly zero', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(validate(makeIntent('revoke')).amountIn).toBe('0');
    expect(() => validate({ ...makeIntent('revoke'), amountIn: '1' })).toThrow();
  });
  for (const field of ['createdAt', 'expiresAt', 'quotedAt']) {
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1793012400000', NaN, Infinity])('rejects invalid ' + field + ' %j', (value) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      expect(() => validate({ ...makeIntent(), [field]: value })).toThrow();
    });
    it('accepts safe nonnegative endpoints for ' + field, () => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      for (const value of [0, Number.MAX_SAFE_INTEGER]) expect(validate({ ...makeIntent(), [field]: value })[field]).toBe(value);
    });
  }
  it.each([[0, 0], [100, 100], [10000, 10000]])('accepts inclusive slippage %s/%s', (slippageBps, maxSlippageBps) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(validate({ ...makeIntent(), slippageBps, maxSlippageBps }).slippageBps).toBe(slippageBps);
  });
  it.each([[101, 100], [10001, 10001], [0, 10001], [-1, 100], [0, -1], [1.5, 100], [0, 1.5], ['100', 100]])('rejects invalid slippage %j/%j', (slippageBps, maxSlippageBps) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(() => validate({ ...makeIntent(), slippageBps, maxSlippageBps })).toThrow();
  });
  for (const field of ['tokenIn', 'tokenOut']) {
    it.each([0, 255])('accepts ' + field + ' decimals %s', (decimals) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = makeIntent(); intent[field].decimals = decimals;
      expect(validate(intent)[field].decimals).toBe(decimals);
    });
    it.each([-1, 256, 1.5, '6', Number.MAX_SAFE_INTEGER + 1])('rejects ' + field + ' decimals %j', (decimals) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = makeIntent(); intent[field].decimals = decimals;
      expect(() => validate(intent)).toThrow();
    });
    it.each(['mint', 'symbol', 'decimals'])('requires ' + field + '.%s', (key) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = makeIntent(); delete intent[field][key]; expect(() => validate(intent)).toThrow();
    });
    it('rejects the EVM address alias on ' + field, () => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = makeIntent(); intent[field].address = intent[field].mint; delete intent[field].mint;
      expect(() => validate(intent)).toThrow();
    });
  }
  it('preserves case-sensitive base58 values byte-for-byte', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); const variant = caseFlip(intent.wallet);
    expect(validate(intent)).toEqual(intent);
    expect(variant).not.toBe(intent.wallet);
    // A canonical case-flipped key is a different key, never normalized to A.
    expect(validate({ ...intent, wallet: variant }).wallet).toBe(variant);
  });
  it.each(['0OIl', '1111', ' ' + makeIntent().wallet, makeIntent().wallet + '\0', base58Encode(new Uint8Array(31)), base58Encode(new Uint8Array(33))])('rejects noncanonical/incorrect-width base58 %j', (value) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    for (const path of ['wallet', 'mint', 'program', 'blockhash']) {
      const intent = makeIntent();
      if (path === 'wallet') intent.wallet = value;
      if (path === 'mint') intent.tokenIn.mint = value;
      if (path === 'program') intent.programIds = [value];
      if (path === 'blockhash') intent.tx.recentBlockhash = value;
      expect(() => validate(intent), path).toThrow();
    }
  });
  it.each(['unsorted', 'duplicate', 'not-array'])('rejects %s programIds', (kind) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.programIds = kind === 'unsorted' ? [...intent.programIds].reverse() : kind === 'duplicate' ? [intent.programIds[0], intent.programIds[0]] : intent.programIds[0];
    expect(() => validate(intent)).toThrow();
  });
});

describe('PR1 tx shape and recursive exact keys', () => {
  it('accepts exactly the durable nonce lifetime variant at schema level', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    expect(validate(durableIntent())).toEqual(durableIntent());
  });
  it.each(['neither', 'both', 'missing-height', 'missing-blockhash', 'wrong-authority', 'missing-nonce-account', 'missing-nonce-value'])('rejects lifetime variant %s', (variant) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = variant.includes('nonce') || variant === 'wrong-authority' ? durableIntent() : makeIntent();
    if (variant === 'neither') { delete intent.tx.recentBlockhash; delete intent.tx.lastValidBlockHeight; }
    if (variant === 'both') intent.tx.durableNonce = durableIntent().tx.durableNonce;
    if (variant === 'missing-height') delete intent.tx.lastValidBlockHeight;
    if (variant === 'missing-blockhash') delete intent.tx.recentBlockhash;
    if (variant === 'wrong-authority') intent.tx.durableNonce.nonceAuthority = deriveKey(LABELS.treasuryB).pubkey;
    if (variant === 'missing-nonce-account') delete intent.tx.durableNonce.nonceAccount;
    if (variant === 'missing-nonce-value') delete intent.tx.durableNonce.nonceValue;
    expect(() => validate(intent)).toThrow();
  });
  it.each(['serializedMessage', 'computeUnitLimit', 'computeUnitPriceMicroLamports'])('requires tx.%s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); delete intent.tx[field]; expect(() => validate(intent)).toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '300000'])('rejects computeUnitLimit %j', (value) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.tx.computeUnitLimit = value; expect(() => validate(intent)).toThrow();
  });
  it.each(['01', '-1', '1e3', '1.5', 1])('rejects CU price %j', (value) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.tx.computeUnitPriceMicroLamports = value; expect(() => validate(intent)).toThrow();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects block height %j', (value) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.tx.lastValidBlockHeight = value; expect(() => validate(intent)).toThrow();
  });
  it.each(['uppercase', 'keccak', 'base64-text', 'wrong', 'short'])('rejects %s routeHash', (variant) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent();
    intent.routeHash = variant === 'uppercase' ? '0x' + intent.routeHash.slice(2).toUpperCase() : variant === 'keccak' ? keccak256(Buffer.from(intent.tx.serializedMessage, 'base64')) : variant === 'base64-text' ? '0x' + sha256(intent.tx.serializedMessage).toString('hex') : variant === 'short' ? '0x12' : '0x' + '00'.repeat(32);
    expect(() => validate(intent)).toThrow();
  });
  it.each(['gA==\n', 'gA', '-A==', '_A==', 'gB==', ' gA==', 'gA==='])('rejects noncanonical base64 %j even with matching decoded routeHash', (message) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.tx.serializedMessage = message;
    intent.routeHash = referenceRouteHash(Buffer.from(message, 'base64'));
    expect(() => validate(intent)).toThrow();
  });
  for (const level of ['request', 'intent', 'tx', 'tokenIn', 'tokenOut', 'durableNonce', 'approval']) {
    it.each(['unexpected', '__proto__', 'constructor', 'prototype'])('rejects recursive key %s at ' + level, (key) => {
      const requestLevel = level === 'request' || level === 'approval';
      const validate = requireFn(intentModule, requestLevel ? 'assertSolanaRequestShape' : 'assertSolanaIntentShape');
      const intent = level === 'durableNonce' ? durableIntent() : makeIntent();
      const request = makeRequest(intent); request.approval = referenceApproval(intent);
      const target = level === 'request' ? request : level === 'approval' ? request.approval : level === 'intent' ? intent : level === 'durableNonce' ? intent.tx.durableNonce : intent[level];
      Object.defineProperty(target, key, { value: true, enumerable: true });
      expect(() => validate(requestLevel ? request : intent)).toThrow();
    });
  }
});

describe('PR1 missing fields, scalar types and envelope binding edges', () => {
  for (const action of ['approve', 'revoke', 'transfer']) {
    it.each(Object.keys(makeIntent(action)))('requires %s for ' + action, (field) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = makeIntent(action); delete intent[field]; expect(() => validate(intent)).toThrow();
    });
  }
  it.each(Object.keys(referenceApproval()))('requires approval.%s when approval is supplied', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); request.approval = referenceApproval(request.structuredIntent); delete request.approval[field];
    expect(() => validate(request)).toThrow();
  });
  it.each(['43114', '1', 'solana:testnet', 'Solana:mainnet', 'solana:mainnet\0'])('rejects malformed request chainId %j', (chainId) => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); request.chainId = chainId; request.structuredIntent.chainId = chainId;
    expect(() => validate(request)).toThrow();
  });
  it('rejects treasury case substitution against the original from', () => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); request.structuredIntent.wallet = caseFlip(request.from);
    expect(() => validate(request)).toThrow();
  });
  it('normalizes request NFC text without modifying pubkeys', () => {
    const validate = requireFn(intentModule, 'assertSolanaRequestShape');
    const request = makeRequest(); request.requestId = 'cafe\u0301'; request.intent = 'e\u0301';
    expect(() => validate(request)).not.toThrow();
  });
  for (const level of ['intent', 'tx', 'tokenIn', 'tokenOut', 'durableNonce']) {
    it.each([null, [], 'wrong', 1])('rejects non-object %j at ' + level, (value) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = level === 'durableNonce' ? durableIntent() : makeIntent();
      if (level === 'intent') { expect(() => validate(value)).toThrow(); return; }
      if (level === 'durableNonce') intent.tx.durableNonce = value;
      else intent[level] = value;
      expect(() => validate(intent)).toThrow();
    });
  }
  for (const field of ['nonceAccount', 'nonceAuthority', 'nonceValue']) {
    it.each(['missing', '0OIl', '1111'])('rejects durable ' + field + ' %s', (value) => {
      const validate = requireFn(intentModule, 'assertSolanaIntentShape');
      const intent = durableIntent();
      if (value === 'missing') delete intent.tx.durableNonce[field]; else intent.tx.durableNonce[field] = value;
      expect(() => validate(intent)).toThrow();
    });
  }
  it.each(['tokenIn', 'tokenOut'])('requires a nonempty string symbol in %s', (field) => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    for (const symbol of ['', 123, null]) {
      const intent = makeIntent(); intent[field].symbol = symbol; expect(() => validate(intent)).toThrow();
    }
  });
  it('accepts zero CU price and the maximum safe positive CU limit as schema values', () => {
    const validate = requireFn(intentModule, 'assertSolanaIntentShape');
    const intent = makeIntent(); intent.tx.computeUnitPriceMicroLamports = '0'; intent.tx.computeUnitLimit = Number.MAX_SAFE_INTEGER;
    expect(validate(intent)).toEqual(intent);
  });
});
