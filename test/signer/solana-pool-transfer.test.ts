import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chainModule from '../../src/signer/chain-policy';
import * as publicModule from '../../src/index';
import { clone, requireFn, USDC } from './solana-test-helpers';
import { JUPITER, key, poolFixture, PROVISIONAL_SOLANA_POLICY } from './solana-message-helpers';

/** Pure contract for assertSolanaPoolTransferAllowed(input), throwing on denial,
 * returning void/true on allowance. `cluster` is the relevant resolved config.
 * Addresses/owners, the complete CPI stack (outermost first), top-level actions
 * and net output credit are already decoded/verified by the caller, not fetched.
 * The caller derives `derivedAta` for (treasury, tokenOut.mint, tokenProgram);
 * this policy compares it without pretending the fixture is a real PDA.
 * An AMM must be in BOTH innerPrograms and the matching pool entry; listing a
 * pool alone does not grant program admission (docs/solana-support.md).
 */
interface PoolTransferInput {
  cluster: {
    jupiter: { allowPoolTransfers: boolean; pools: Array<ReturnType<typeof poolFixture>> };
    innerPrograms: string[];
    delegates: string[];
  };
  treasury: string;
  intent: { tokenOut: { mint: string }; minAmountOut: string };
  transfer: { destination: string; destinationOwner: string; amount: string; topLevel: boolean; invokingPrograms: string[] };
  outputAccount: { address: string; owner: string; mint: string; derivedAta: string };
  simulatedOutputCredit: string;
  topLevelTransfers: Array<{ destination: string; destinationOwner: string; kind: 'transferChecked' | 'system' | 'approve'; delegate?: string }>;
}

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 pool policy test: fetch forbidden'); });
  vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => {
  try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

function validInput(): PoolTransferInput {
  const pool = poolFixture(); const treasury = key('pool-test-treasury');
  const outputAta = key('caller-derived-output-ata'); const delegate = key('reviewed-delegate');
  return {
    cluster: { jupiter: { allowPoolTransfers: true, pools: [pool] }, innerPrograms: [pool.ammProgram], delegates: [delegate] },
    treasury, intent: { tokenOut: { mint: USDC }, minAmountOut: '1000' },
    transfer: { destination: pool.vaultA, destinationOwner: pool.authority, amount: '5000', topLevel: false, invokingPrograms: [JUPITER, pool.ammProgram] },
    outputAccount: { address: outputAta, owner: treasury, mint: USDC, derivedAta: outputAta },
    simulatedOutputCredit: '1001',
    topLevelTransfers: [
      { kind: 'transferChecked', destination: outputAta, destinationOwner: treasury },
      { kind: 'system', destination: treasury, destinationOwner: treasury },
      { kind: 'approve', destination: outputAta, destinationOwner: treasury, delegate },
    ],
  };
}
function expectAllowed(check: (...args: any[]) => any, input: PoolTransferInput) {
  expect([undefined, true], 'allow contract returns void or true').toContain(check(input));
}
type DenyCase = { name: string; prepare?: (input: PoolTransferInput) => void; mutate: (input: PoolTransferInput) => void };
const denyCases: DenyCase[] = [
  { name: 'provisional default disables the exemption', mutate: (i) => { i.cluster.jupiter.allowPoolTransfers = PROVISIONAL_SOLANA_POLICY.allowPoolTransfersDefault; } },
  { name: 'vault transfer is top-level', mutate: (i) => { i.transfer.topLevel = true; } },
  // An AMM-only CPI is allowlisted before the mutation. Removing its admission is
  // one violation; it necessarily also means there is no allowlisted stack entry.
  { name: 'CPI stack has no allowlisted program', prepare: (i) => { i.transfer.invokingPrograms = [i.cluster.jupiter.pools[0].ammProgram]; },
    mutate: (i) => { i.cluster.innerPrograms = []; } },
  { name: 'destination vault is absent from jupiter.pools', mutate: (i) => { i.transfer.destination = key('unlisted-vault'); } },
  { name: 'pool AMM is absent from the invoking CPI chain', mutate: (i) => { i.transfer.invokingPrograms = [JUPITER]; } },
  { name: 'pool AMM is not allowlisted even with Jupiter in the CPI chain', mutate: (i) => { i.cluster.innerPrograms = []; } },
  { name: 'invariant 1: output owner is not treasury', mutate: (i) => { i.outputAccount.owner = key('other-owner'); } },
  { name: 'invariant 1: output address is not the caller-derived treasury ATA', mutate: (i) => { i.outputAccount.address = key('other-token-account'); } },
  { name: 'invariant 1: output mint differs from tokenOut.mint', mutate: (i) => { i.outputAccount.mint = key('other-output-mint'); } },
  { name: 'invariant 2: simulated credit is below minAmountOut', mutate: (i) => { i.simulatedOutputCredit = '999'; } },
  { name: 'invariant 2: below-minimum comparison remains exact above 2^53',
    prepare: (i) => { i.intent.minAmountOut = '9007199254740993'; i.simulatedOutputCredit = '9007199254740994'; },
    mutate: (i) => { i.simulatedOutputCredit = '9007199254740992'; } },
  { name: 'invariant 3: any top-level transferChecked has an external destination owner', mutate: (i) => {
    i.topLevelTransfers.push({ kind: 'transferChecked', destination: key('external-token-account'), destinationOwner: key('external-owner') });
  } },
  { name: 'invariant 3: any top-level System transfer has an external destination owner', mutate: (i) => {
    i.topLevelTransfers.push({ kind: 'system', destination: key('external-system-account'), destinationOwner: key('external-owner') });
  } },
  { name: 'invariant 3: top-level approve names an unallowlisted delegate', mutate: (i) => { i.topLevelTransfers[2].delegate = key('unreviewed-delegate'); } },
];

describe('PR2 pure CPI-only pool transfer policy contract', () => {
  it('allows a listed vault inside Jupiter and admitted AMM CPI with all three invariants', () => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed'); expectAllowed(check, validInput());
  });
  it('re-exports the chain-policy contract through the package index', () => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed');
    expect(requireFn(publicModule, 'assertSolanaPoolTransferAllowed')).toBe(check);
  });
  it.each(denyCases)('denies $name', ({ prepare, mutate }) => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed'); const input = validInput(); prepare?.(input);
    // Prove each baseline is allowed before changing one independent policy fact;
    // an always-throw implementation cannot pass any denial test.
    expectAllowed(check, clone(input)); mutate(input); expect(() => check(input)).toThrow();
  });
  it.each(['1000', '9007199254740993'])('allows inclusive minAmountOut equality exactly at %s', (minimum) => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed'); const input = validInput();
    input.intent.minAmountOut = minimum; input.simulatedOutputCredit = minimum; expectAllowed(check, input);
  });
  it('an allowlisted approve delegate does not by itself deny the pool exemption', () => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed'); const input = validInput();
    input.topLevelTransfers = [input.topLevelTransfers[2]]; expectAllowed(check, input);
  });
  it('allows either listed vault (vaultB as well as vaultA)', () => {
    const check = requireFn(chainModule, 'assertSolanaPoolTransferAllowed'); const input = validInput();
    input.transfer.destination = input.cluster.jupiter.pools[0].vaultB; expectAllowed(check, input);
  });
});
