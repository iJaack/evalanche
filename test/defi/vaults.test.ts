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

import { Contract, MaxUint256, parseUnits, formatUnits } from 'ethers';
import { VaultClient, YOUSD_VAULT } from '../../src/defi/vaults';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMockSigner() {
  return {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    provider: { _isProvider: true },
  } as unknown as ConstructorParameters<typeof VaultClient>[0];
}

const USDC_ASSET = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const DEPOSIT_AMOUNT = parseUnits('1000', 6); // 1000 USDC
const EXPECTED_SHARES = parseUnits('990', 6); // slight fee on deposit
const EXPECTED_ASSETS = parseUnits('1010', 6); // slight gain on redeem
const TOTAL_ASSETS = parseUnits('5000000', 6); // 5M USDC total

function makeContractMock(overrides: Record<string, unknown> = {}) {
  return {
    name: vi.fn().mockResolvedValue('yoUSD Vault'),
    asset: vi.fn().mockResolvedValue(USDC_ASSET),
    totalAssets: vi.fn().mockResolvedValue(TOTAL_ASSETS),
    decimals: vi.fn().mockResolvedValue(6),
    previewDeposit: vi.fn().mockResolvedValue(EXPECTED_SHARES),
    previewRedeem: vi.fn().mockResolvedValue(EXPECTED_ASSETS),
    balanceOf: vi.fn().mockResolvedValue(parseUnits('500', 6)),
    deposit: vi.fn().mockResolvedValue({
      hash: '0xdeposit123',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    redeem: vi.fn().mockResolvedValue({
      hash: '0xredeem456',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
    allowance: vi.fn().mockResolvedValue(MaxUint256),
    approve: vi.fn().mockResolvedValue({
      hash: '0xapprove',
      wait: vi.fn().mockResolvedValue({}),
    }),
    // ERC20 helpers
    symbol: vi.fn().mockResolvedValue('USDC'),
    ...overrides,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('VaultClient — constants', () => {
  it('YOUSD_VAULT is the correct Base address', () => {
    expect(YOUSD_VAULT.toLowerCase()).toBe(
      '0x0000000f2eb9f69274678c76222b35eec7588a65',
    );
  });
});

// ─── vaultInfo ────────────────────────────────────────────────────────────────

describe('VaultClient.vaultInfo', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns vault metadata', async () => {
    const client = new VaultClient(makeMockSigner(), 'base');
    const info = await client.vaultInfo(YOUSD_VAULT);

    expect(info.name).toBe('yoUSD Vault');
    expect(info.asset).toBe(USDC_ASSET);
    expect(info.eip4626).toBe(true);
    expect(info.chain).toBe('base');
    expect(parseFloat(info.totalAssets)).toBeGreaterThan(0);
  });

  it('wraps errors in VAULT_ERROR', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      name: vi.fn().mockRejectedValue(new Error('not a vault')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new VaultClient(makeMockSigner(), 'base');
    await expect(client.vaultInfo(YOUSD_VAULT)).rejects.toMatchObject({
      code: EvalancheErrorCode.VAULT_ERROR,
    });
  });
});

// ─── depositQuote ─────────────────────────────────────────────────────────────

describe('VaultClient.depositQuote', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns expected shares for a deposit amount', async () => {
    const client = new VaultClient(makeMockSigner(), 'base');
    const quote = await client.depositQuote(YOUSD_VAULT, '1000');

    expect(quote.shares).toBe(formatUnits(EXPECTED_SHARES, 6));
    expect(quote.expectedAssets).toBe('1000');
  });

  it('wraps errors in VAULT_ERROR', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      previewDeposit: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new VaultClient(makeMockSigner(), 'base');
    await expect(client.depositQuote(YOUSD_VAULT, '1000')).rejects.toMatchObject({
      code: EvalancheErrorCode.VAULT_ERROR,
    });
  });
});

// ─── deposit ──────────────────────────────────────────────────────────────────

describe('VaultClient.deposit', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('deposits and returns transaction result', async () => {
    const client = new VaultClient(makeMockSigner(), 'base');
    const result = await client.deposit(YOUSD_VAULT, '1000');

    expect(result.hash).toBe('0xdeposit123');
    expect(result.receipt.status).toBe(1);
  });

  it('wraps deposit errors in VAULT_ERROR', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      deposit: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new VaultClient(makeMockSigner(), 'base');
    await expect(client.deposit(YOUSD_VAULT, '1000')).rejects.toMatchObject({
      code: EvalancheErrorCode.VAULT_ERROR,
    });
  });
});

// ─── withdrawQuote ────────────────────────────────────────────────────────────

describe('VaultClient.withdrawQuote', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('returns expected assets for a share amount', async () => {
    const client = new VaultClient(makeMockSigner(), 'base');
    const quote = await client.withdrawQuote(YOUSD_VAULT, '990');

    expect(quote.shares).toBe('990');
    expect(quote.expectedAssets).toBe(formatUnits(EXPECTED_ASSETS, 6));
  });

  it('wraps errors in VAULT_ERROR', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      previewRedeem: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new VaultClient(makeMockSigner(), 'base');
    await expect(client.withdrawQuote(YOUSD_VAULT, '990')).rejects.toMatchObject({
      code: EvalancheErrorCode.VAULT_ERROR,
    });
  });
});

// ─── withdraw ─────────────────────────────────────────────────────────────────

describe('VaultClient.withdraw', () => {
  beforeEach(() => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock() as unknown as InstanceType<typeof Contract>);
  });

  it('redeems shares and returns transaction result', async () => {
    const client = new VaultClient(makeMockSigner(), 'base');
    const result = await client.withdraw(YOUSD_VAULT, '990');

    expect(result.hash).toBe('0xredeem456');
    expect(result.receipt.status).toBe(1);
  });

  it('wraps withdraw errors in VAULT_ERROR', async () => {
    vi.mocked(Contract).mockImplementation(() => makeContractMock({
      redeem: vi.fn().mockRejectedValue(new Error('revert')),
    }) as unknown as InstanceType<typeof Contract>);

    const client = new VaultClient(makeMockSigner(), 'base');
    await expect(client.withdraw(YOUSD_VAULT, '990')).rejects.toMatchObject({
      code: EvalancheErrorCode.VAULT_ERROR,
    });
  });
});
