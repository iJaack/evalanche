import { describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import * as intentModule from '../../src/signer/intent';
import * as jcsModule from '../../src/signer/jcs';
import { AVALANCHE_UNISWAP_V3_NPM } from '../../src/signer/clmm';
import {
  clone, durableIntent, makeEvmIntent, makeIntent, makeRequest, referenceJcs,
  type RecordValue,
} from './solana-test-helpers';

const SPARSE_VARIANTS = ['all holes', 'middle hole hiding a duplicate', 'leading hole', 'trailing hole', 'single hole'] as const;
type SparseVariant = typeof SPARSE_VARIANTS[number];

// Construct holes only after cloning an intent: the JSON-based clone erases them.
function sparseArray<T>(variant: SparseVariant, a: T, b: T): T[] {
  switch (variant) {
    case 'all holes': return new Array<T>(2);
    case 'middle hole hiding a duplicate': {
      const out = [a]; out[2] = a; return out;
    }
    case 'leading hole': {
      const out = new Array<T>(3); out[1] = a; out[2] = b; return out;
    }
    case 'trailing hole': {
      const out = [a, b]; out.length = 3; return out;
    }
    case 'single hole': return new Array<T>(1);
  }
}

function arrayPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return [path, ...value.flatMap((entry, i) => arrayPaths(entry, `${path}[${i}]`))];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => arrayPaths(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

const SOLANA_CASES: Array<[string, () => RecordValue]> = [
  ...['swap', 'approve', 'revoke', 'transfer'].map((action): [string, () => RecordValue] => [action, () => makeIntent(action)]),
  ['system transfer', () => {
    const intent = makeIntent('transfer'); intent.venue = 'system';
    intent.tokenIn = { mint: makeIntent().tokenOut.mint, symbol: 'SOL', decimals: 9 };
    return intent;
  }],
  ['durable nonce', durableIntent],
];

const EVM_FIELDS = ['signalRefs', 'clmm.ownedTokenIds'] as const;
type EvmArrayField = typeof EVM_FIELDS[number];
function evmIntentWithArray(field: EvmArrayField): RecordValue {
  const intent = clone(makeEvmIntent());
  if (field === 'signalRefs') intent.signalRefs = ['sig-1', 'sig-2'];
  else {
    intent.venue = 'uniswap-v3'; intent.action = 'clmm';
    intent.tx.to = AVALANCHE_UNISWAP_V3_NPM;
    intent.routeHash = intentModule.computeApprovedTxHash(intent.tx);
    intent.clmm = { ownedTokenIds: ['42', '43'] };
  }
  return intent;
}
function evmArrayOwner(intent: RecordValue, field: EvmArrayField): [RecordValue, string] {
  return field === 'signalRefs' ? [intent, 'signalRefs'] : [intent.clmm, 'ownedTokenIds'];
}

describe('PR1 sparse Solana programIds schema rejection', () => {
  it('enumerates every array field across all Solana actions and lifetime variants', () => {
    const paths = new Set<string>();
    for (const [, make] of SOLANA_CASES) {
      const intent = make();
      expect(intentModule.assertSolanaIntentShape(intent)).toEqual(intent);
      arrayPaths(intent).forEach((path) => paths.add(path));
    }
    // A new array-valued schema field must get sparse-array coverage too.
    expect([...paths].sort()).toEqual(['programIds']);
  });

  it.each(SOLANA_CASES)('accepts dense programIds for %s at every schema entry point', (_name, make) => {
    const intent = make();
    expect(intentModule.assertSolanaIntentShape(intent)).toEqual(intent);
    expect(intentModule.assertIntentShape(intent)).toEqual(intent);
    expect(intentModule.assertSolanaRequestShape(makeRequest(intent)).structuredIntent).toEqual(intent);
  });

  for (const entryPoint of ['assertSolanaIntentShape', 'assertIntentShape', 'assertSolanaRequestShape'] as const) {
    it.each(SPARSE_VARIANTS)(entryPoint + ' rejects programIds with %s', (variant) => {
      const intent = clone(makeIntent());
      intent.programIds = sparseArray(variant, intent.programIds[0], intent.programIds[1]);
      const input = entryPoint === 'assertSolanaRequestShape' ? makeRequest(intent) : intent;
      expect(() => intentModule[entryPoint](input)).toThrow();
    });
  }
});

describe('PR1 sparse arrays cannot acquire an intent hash', () => {
  it.each(SPARSE_VARIANTS)('rejects Solana programIds with %s', (variant) => {
    const intent = clone(makeIntent());
    intent.programIds = sparseArray(variant, intent.programIds[0], intent.programIds[1]);
    expect(() => intentModule.computeIntentHash(intent as intentModule.SolanaSigningIntent)).toThrow();
  });

  for (const [name, make] of SOLANA_CASES) {
    it.each([0, 1, 2])('preserves the reference hash for dense ' + name + ' programIds of length %i', (length) => {
      const intent = clone(make()); intent.programIds = intent.programIds.slice(0, length);
      expect(intentModule.assertSolanaIntentShape(intent)).toEqual(intent);
      expect(intentModule.computeIntentHash(intent as intentModule.SolanaSigningIntent))
        .toBe(keccak256(toUtf8Bytes(referenceJcs(intent))));
    });
  }

  it('enumerates every EVM array field, including optional nested CLMM ownership', () => {
    const paths = new Set<string>();
    const intent = evmIntentWithArray('clmm.ownedTokenIds');
    intent.signalRefs = evmIntentWithArray('signalRefs').signalRefs;
    expect(intentModule.assertIntentShape(intent)).toEqual(intent);
    arrayPaths(intent).forEach((path) => paths.add(path));
    expect([...paths].sort()).toEqual(['clmm.ownedTokenIds', 'signalRefs']);
  });

  for (const field of EVM_FIELDS) {
    it.each(SPARSE_VARIANTS)('rejects EVM ' + field + ' with %s', (variant) => {
      const intent = clone(evmIntentWithArray(field));
      const [owner, key] = evmArrayOwner(intent, field);
      owner[key] = sparseArray(variant, owner[key][0], owner[key][1]);
      expect(() => intentModule.computeIntentHash(intent as intentModule.SigningIntent)).toThrow();
    });

    it.each([0, 1, 2])('preserves the reference hash for dense EVM ' + field + ' of length %i', (length) => {
      const intent = evmIntentWithArray(field);
      const [owner, key] = evmArrayOwner(intent, field); owner[key] = owner[key].slice(0, length);
      expect(intentModule.assertIntentShape(intent)).toEqual(intent);
      expect(intentModule.computeIntentHash(intent as intentModule.SigningIntent))
        .toBe(keccak256(toUtf8Bytes(referenceJcs(intent))));
    });
  }
});

describe('PR1 canonical JSON rejects holes at every depth', () => {
  for (const [name, canonicalJson] of [
    ['intent export', intentModule.canonicalJson], ['jcs export', jcsModule.canonicalJson],
  ] as const) {
    for (const placement of ['top level', 'inside an object', 'inside an array'] as const) {
      it.each(SPARSE_VARIANTS)(name + ' rejects %s ' + placement, (variant) => {
        const sparse = sparseArray(variant, 1, 2);
        const value = placement === 'top level' ? sparse : placement === 'inside an object'
          ? { a: { b: sparse } } : [0, sparse, 3];
        expect(() => canonicalJson(value)).toThrow();
      });
    }

    it(name + ' preserves dense arrays and sorted object keys', () => {
      expect(canonicalJson([])).toBe('[]');
      expect(canonicalJson([1, 'x', null])).toBe('[1,"x",null]');
      expect(canonicalJson({ b: [1, 'x', null], a: [] })).toBe('{"a":[],"b":[1,"x",null]}');
      expect(canonicalJson([0, [1, 'x', null], 3])).toBe('[0,[1,"x",null],3]');
    });
  }
});

function typedData(): intentModule.TypedDataPayload {
  return {
    domain: { name: 'Sparse array regression', version: '1', chainId: 43114 },
    types: { Order: [{ name: 'amounts', type: 'uint256[]' }, { name: 'nonce', type: 'uint256' }] },
    value: { amounts: ['1', '2'], nonce: '1' },
  };
}

describe('PR1 typed-data route hashes reject sparse arrays', () => {
  for (const field of ['types.Order', 'value.amounts'] as const) {
    it.each(SPARSE_VARIANTS)('rejects ' + field + ' with %s', (variant) => {
      const typed = clone(typedData());
      if (field === 'types.Order') {
        typed.types.Order = sparseArray(variant, typed.types.Order[0], typed.types.Order[1]);
      } else {
        const amounts = typed.value.amounts as string[];
        typed.value.amounts = sparseArray(variant, amounts[0], amounts[1]);
      }
      expect(() => intentModule.computeTypedDataRouteHash(typed)).toThrow();
    });

    it('preserves the reference route hash for dense ' + field, () => {
      const typed = typedData();
      expect(intentModule.computeTypedDataRouteHash(typed)).toBe(keccak256(toUtf8Bytes(referenceJcs(typed))));
    });
  }
});
