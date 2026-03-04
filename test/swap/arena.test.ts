import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalancheErrorCode } from '../../src/utils/errors';

// ─── Mock ethers ──────────────────────────────────────────────────────────────
// vi.mock is hoisted above imports by Vitest's transformer, so `Contract` below
// is a vi.fn() that we can reconfigure per test via vi.mocked(Contract).
vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Contract: vi.fn(),
  };
});

// Now import the module under test (after the mock declaration)
import { Contract, MaxUint256 } from 'ethers';
import { ArenaSwapClient, ARENA_TOKEN, ARENA_TOKEN_MANAGER } from '../../src/swap/arena';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EVA_TOKEN = '0x6Ae3b236d5546369db49AFE3AecF7e32c5F27672';
const EVA_TOKEN_ID = 100_000_000_042n;

/** Build a mock ethers signer */
function makeMockSigner(opts: { hasProvider?: boolean } = {}) {
  return {
    address: '0x0fE61780BD5508b3C99E420662050E5560608cA4',
    provider: opts.hasProvider === false ? null : ({ _isProvider: true } as unknown),
    sendTransaction: vi.fn(),
  } as unknown as ConstructorParameters<typeof ArenaSwapClient>[0];
}

/** Create a contract mock object with sensible defaults */
function makeContractMock(overrides: Record<string, unknown> = {}) {
  return {
    getTokenInfo: vi.fn().mockImplementation(async (id: bigint) => {
      if (id === EVA_TOKEN_ID) return { tokenAddress: EVA_TOKEN };
      return { tokenAddress: '0x0000000000000000000000000000000000000001' };
    }),
    calculateCostWithFees: vi.fn().mockResolvedValue(5_000_000_000_000_000_000n),
    buyAndCreateLpIfPossible: vi.fn().mockResolvedValue({
      hash: '0xabc123',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    sell: vi.fn().mockResolvedValue({
      hash: '0xdef456',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    allowance: vi.fn().mockResolvedValue(MaxUint256),
    approve: vi.fn().mockResolvedValue({ hash: '0xapprove', wait: vi.fn().mockResolvedValue({}) }),
    ...overrides,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('ArenaSwapClient — constants', () => {
  it('ARENA_TOKEN_MANAGER is the correct proxy address', () => {
    expect(ARENA_TOKEN_MANAGER.toLowerCase()).toBe(
      '0x2196e106af476f57618373ec028924767c758464',
    );
  });

  it('ARENA_TOKEN is the correct ERC-20 address', () => {
    expect(ARENA_TOKEN.toLowerCase()).toBe(
      '0xb8d7710f7d8349a506b75dd184f05777c82dad0c',
    );
  });
});

// ─── getArenaTokenId ──────────────────────────────────────────────────────────

describe('ArenaSwapClient.getArenaTokenId', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('finds the tokenId when the address matches in the first batch', async () => {
    const client = new ArenaSwapClient(makeMockSigner());
    const tokenId = await client.getArenaTokenId(EVA_TOKEN);
    expect(tokenId).toBe(EVA_TOKEN_ID);
  });

  it('is case-insensitive when matching token addresses', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      getTokenInfo: vi.fn().mockImplementation(async (id: bigint) => {
        if (id === EVA_TOKEN_ID) return { tokenAddress: EVA_TOKEN.toUpperCase() };
        return { tokenAddress: '0x0000000000000000000000000000000000000001' };
      }),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    const tokenId = await client.getArenaTokenId(EVA_TOKEN.toLowerCase());
    expect(tokenId).toBe(EVA_TOKEN_ID);
  });

  it('throws ARENA_TOKEN_NOT_FOUND when getTokenInfo always reverts (token not registered)', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      getTokenInfo: vi.fn().mockRejectedValue(new Error('execution reverted')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    await expect(
      client.getArenaTokenId('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toMatchObject({ code: EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND });
  });

  it('throws ARENA_TOKEN_NOT_FOUND when signer has no provider', async () => {
    const client = new ArenaSwapClient(makeMockSigner({ hasProvider: false }));
    // Use an address that is not in the module-level cache to trigger the provider check
    const uncachedAddress = '0x1111111111111111111111111111111111111111';
    await expect(client.getArenaTokenId(uncachedAddress)).rejects.toMatchObject({
      code: EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND,
    });
  });

  it('returns cached tokenId on second call (no extra RPC calls)', async () => {
    const getTokenInfo = vi.fn().mockImplementation(async (id: bigint) => {
      if (id === EVA_TOKEN_ID) return { tokenAddress: EVA_TOKEN };
      return { tokenAddress: '0x0000000000000000000000000000000000000001' };
    });
    vi.mocked(Contract).mockImplementation(() => makeContractMock({ getTokenInfo }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());

    const first = await client.getArenaTokenId(EVA_TOKEN);
    const callsAfterFirst = getTokenInfo.mock.calls.length;

    // Second call should use cache — no additional RPC calls
    const second = await client.getArenaTokenId(EVA_TOKEN);
    expect(second).toBe(first);
    expect(getTokenInfo.mock.calls.length).toBe(callsAfterFirst);
  });
});

// ─── calculateBuyCost ─────────────────────────────────────────────────────────

describe('ArenaSwapClient.calculateBuyCost', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns the $ARENA cost in wei for a given amount', async () => {
    const client = new ArenaSwapClient(makeMockSigner());
    const cost = await client.calculateBuyCost(EVA_TOKEN, 100n * 10n ** 18n);
    expect(cost).toBe(5_000_000_000_000_000_000n);
  });

  it('passes the correct (tokenId, amount) args to calculateCostWithFees', async () => {
    const calculateCostWithFees = vi.fn().mockResolvedValue(1n);
    vi.mocked(Contract).mockImplementation(() => makeContractMock({ calculateCostWithFees }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    const amount = 50n * 10n ** 18n;
    await client.calculateBuyCost(EVA_TOKEN, amount);

    expect(calculateCostWithFees).toHaveBeenCalledWith(amount, EVA_TOKEN_ID);
  });

  it('wraps contract errors in ARENA_SWAP_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      calculateCostWithFees: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    await expect(client.calculateBuyCost(EVA_TOKEN, 1n)).rejects.toMatchObject({
      code: EvalancheErrorCode.ARENA_SWAP_FAILED,
    });
  });
});

// ─── getTokenInfo ─────────────────────────────────────────────────────────────

describe('ArenaSwapClient.getTokenInfo', () => {
  const rawInfo = {
    protocolFee: 3,
    creatorFee: 5,
    referralFee: 2,
    tokenCreationBuyFee: 1_000_000_000_000_000_000n,
    curveScaler: 2_000_000_000_000_000_000n,
    a: 100,
    tokenAddress: EVA_TOKEN,
  };

  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      getTokenInfo: vi.fn().mockResolvedValue(rawInfo),
    }) as unknown as InstanceType<typeof Contract>);
  });

  it('parses all token info fields correctly', async () => {
    const client = new ArenaSwapClient(makeMockSigner());
    const info = await client.getTokenInfo(EVA_TOKEN_ID);

    expect(info.protocolFee).toBe(3);
    expect(info.creatorFee).toBe(5);
    expect(info.referralFee).toBe(2);
    expect(info.tokenCreationBuyFee).toBe(1_000_000_000_000_000_000n);
    expect(info.curveScaler).toBe(2_000_000_000_000_000_000n);
    expect(info.a).toBe(100);
    expect(info.tokenAddress).toBe(EVA_TOKEN);
  });

  it('throws ARENA_TOKEN_NOT_FOUND when getTokenInfo reverts', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      getTokenInfo: vi.fn().mockRejectedValue(new Error('execution reverted')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    await expect(client.getTokenInfo(99n)).rejects.toMatchObject({
      code: EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND,
    });
  });
});

// ─── buyArenaToken ────────────────────────────────────────────────────────────

describe('ArenaSwapClient.buyArenaToken', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns a swap result with txHash and tokenId', async () => {
    const client = new ArenaSwapClient(makeMockSigner());
    const result = await client.buyArenaToken(
      EVA_TOKEN,
      100n * 10n ** 18n,
      50n * 10n ** 18n,
    );

    expect(result.txHash).toBe('0xabc123');
    expect(result.success).toBe(true);
    expect(result.tokenId).toBe(EVA_TOKEN_ID);
  });

  it('wraps buy errors in ARENA_SWAP_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      buyAndCreateLpIfPossible: vi.fn().mockRejectedValue(new Error('slippage')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    await expect(
      client.buyArenaToken(EVA_TOKEN, 100n * 10n ** 18n, 50n * 10n ** 18n),
    ).rejects.toMatchObject({ code: EvalancheErrorCode.ARENA_SWAP_FAILED });
  });
});

// ─── sellArenaToken ───────────────────────────────────────────────────────────

describe('ArenaSwapClient.sellArenaToken', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns a swap result with txHash and tokenId', async () => {
    const client = new ArenaSwapClient(makeMockSigner());
    const result = await client.sellArenaToken(
      EVA_TOKEN,
      50n * 10n ** 18n,
      1n * 10n ** 18n,
    );

    expect(result.txHash).toBe('0xdef456');
    expect(result.success).toBe(true);
    expect(result.tokenId).toBe(EVA_TOKEN_ID);
  });

  it('wraps sell errors in ARENA_SWAP_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      sell: vi.fn().mockRejectedValue(new Error('insufficient output')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new ArenaSwapClient(makeMockSigner());
    await expect(
      client.sellArenaToken(EVA_TOKEN, 50n * 10n ** 18n, 1n * 10n ** 18n),
    ).rejects.toMatchObject({ code: EvalancheErrorCode.ARENA_SWAP_FAILED });
  });
});
