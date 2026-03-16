import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalancheErrorCode } from '../../src/utils/errors';

// ─── Mock ethers ──────────────────────────────────────────────────────────────
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Contract: vi.fn(),
  };
});

import { Contract, parseEther, formatEther } from 'ethers';
import { LiquidStakingClient, SAVAX_CONTRACT } from '../../src/defi/liquid-staking';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Build a mock ethers signer */
function makeMockSigner() {
  return {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    provider: { _isProvider: true },
  } as unknown as ConstructorParameters<typeof LiquidStakingClient>[0];
}

// Realistic values: 10 AVAX → ~9.5 sAVAX shares (exchange rate ~0.95)
const TEN_AVAX = parseEther('10');
const EXPECTED_SHARES = parseEther('9.5');
const EXPECTED_AVAX_BACK = parseEther('10.526'); // shares → AVAX at slightly different rate
const POOL_BALANCE_HIGH = parseEther('1000'); // plenty of liquidity
const POOL_BALANCE_LOW = parseEther('1'); // not enough liquidity
const WALLET_BALANCE_HIGH = parseEther('100');
const WALLET_BALANCE_LOW = parseEther('0.5');

function makeContractMock(overrides: Record<string, unknown> = {}) {
  return {
    getSharesByPooledAvax: vi.fn().mockResolvedValue(EXPECTED_SHARES),
    getPooledAvaxByShares: vi.fn().mockResolvedValue(EXPECTED_AVAX_BACK),
    instantPoolBalance: vi.fn().mockResolvedValue(POOL_BALANCE_HIGH),
    balanceOf: vi.fn().mockResolvedValue(WALLET_BALANCE_HIGH),
    submit: vi.fn().mockResolvedValue({
      hash: '0xstake123',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    redeemInstant: vi.fn().mockResolvedValue({
      hash: '0xunstake456',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    requestRedeem: vi.fn().mockResolvedValue({
      hash: '0xdelayed789',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    ...overrides,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('LiquidStakingClient — constants', () => {
  it('SAVAX_CONTRACT is the correct Benqi address', () => {
    expect(SAVAX_CONTRACT.toLowerCase()).toBe(
      '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be',
    );
  });
});

// ─── sAvaxStakeQuote ──────────────────────────────────────────────────────────

describe('LiquidStakingClient.sAvaxStakeQuote', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns a stake quote with shares and rate', async () => {
    const client = new LiquidStakingClient(makeMockSigner());
    const quote = await client.sAvaxStakeQuote('10');

    expect(quote.shares).toBe(formatEther(EXPECTED_SHARES));
    expect(quote.expectedOutput).toBe(formatEther(EXPECTED_SHARES));
    expect(parseFloat(quote.rate)).toBeGreaterThan(0);
  });

  it('wraps contract errors in CONTRACT_CALL_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      getSharesByPooledAvax: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    await expect(client.sAvaxStakeQuote('10')).rejects.toMatchObject({
      code: EvalancheErrorCode.CONTRACT_CALL_FAILED,
    });
  });
});

// ─── sAvaxStake ───────────────────────────────────────────────────────────────

describe('LiquidStakingClient.sAvaxStake', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('stakes AVAX and returns transaction result', async () => {
    const client = new LiquidStakingClient(makeMockSigner());
    const result = await client.sAvaxStake('10');

    expect(result.hash).toBe('0xstake123');
    expect(result.receipt.status).toBe(1);
  });

  it('wraps stake errors in TRANSACTION_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      submit: vi.fn().mockRejectedValue(new Error('out of gas')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    await expect(client.sAvaxStake('10')).rejects.toMatchObject({
      code: EvalancheErrorCode.TRANSACTION_FAILED,
    });
  });
});

// ─── sAvaxUnstakeQuote ────────────────────────────────────────────────────────

describe('LiquidStakingClient.sAvaxUnstakeQuote', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns an unstake quote with pool balance and instant flag', async () => {
    const client = new LiquidStakingClient(makeMockSigner());
    const quote = await client.sAvaxUnstakeQuote('10');

    expect(quote.avaxOut).toBe(formatEther(EXPECTED_AVAX_BACK));
    expect(quote.isInstant).toBe(true);
    expect(parseFloat(quote.poolBalance)).toBeGreaterThan(0);
  });

  it('sets isInstant to false when pool is too low', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      instantPoolBalance: vi.fn().mockResolvedValue(POOL_BALANCE_LOW),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    const quote = await client.sAvaxUnstakeQuote('10');

    expect(quote.isInstant).toBe(false);
  });
});

// ─── sAvaxUnstakeInstant ──────────────────────────────────────────────────────

describe('LiquidStakingClient.sAvaxUnstakeInstant', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('unstakes sAVAX instantly and returns transaction result', async () => {
    const client = new LiquidStakingClient(makeMockSigner());
    const result = await client.sAvaxUnstakeInstant('10');

    expect(result.hash).toBe('0xunstake456');
    expect(result.receipt.status).toBe(1);
  });

  it('throws STAKE_POOL_INSUFFICIENT when pool is too low', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      instantPoolBalance: vi.fn().mockResolvedValue(POOL_BALANCE_LOW),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    await expect(client.sAvaxUnstakeInstant('10')).rejects.toMatchObject({
      code: EvalancheErrorCode.STAKE_POOL_INSUFFICIENT,
    });
  });

  it('throws INSUFFICIENT_BALANCE when wallet balance is too low', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      balanceOf: vi.fn().mockResolvedValue(WALLET_BALANCE_LOW),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    await expect(client.sAvaxUnstakeInstant('10')).rejects.toMatchObject({
      code: EvalancheErrorCode.INSUFFICIENT_BALANCE,
    });
  });
});

// ─── sAvaxUnstakeDelayed ──────────────────────────────────────────────────────

describe('LiquidStakingClient.sAvaxUnstakeDelayed', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('requests delayed unstake and returns transaction result', async () => {
    const client = new LiquidStakingClient(makeMockSigner());
    const result = await client.sAvaxUnstakeDelayed('10');

    expect(result.hash).toBe('0xdelayed789');
    expect(result.receipt.status).toBe(1);
  });

  it('throws INSUFFICIENT_BALANCE when wallet balance is too low', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      balanceOf: vi.fn().mockResolvedValue(WALLET_BALANCE_LOW),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new LiquidStakingClient(makeMockSigner());
    await expect(client.sAvaxUnstakeDelayed('10')).rejects.toMatchObject({
      code: EvalancheErrorCode.INSUFFICIENT_BALANCE,
    });
  });
});
