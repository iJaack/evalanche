import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalancheErrorCode } from '../../src/utils/errors';

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Contract: vi.fn(),
  };
});

import { Contract } from 'ethers';
import { approveAndCall, upgradeProxy } from '../../src/utils/contract-helpers';

function makeMockSigner() {
  return {
    address: '0x1234567890123456789012345678901234567890',
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0xcalltx',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    }),
  } as unknown as Parameters<typeof approveAndCall>[0];
}

describe('approveAndCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approves first, then executes follow-up contract call', async () => {
    const approve = vi.fn().mockResolvedValue({
      hash: '0xapprovetx',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });
    vi.mocked(Contract).mockImplementation(() => ({ approve }) as unknown as InstanceType<typeof Contract>);

    const signer = makeMockSigner();
    const result = await approveAndCall(
      signer,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      100n,
      '0xdeadbeef',
    );

    expect(approve).toHaveBeenCalledWith('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 100n);
    expect(signer.sendTransaction).toHaveBeenCalledWith({
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      data: '0xdeadbeef',
      value: undefined,
      gasLimit: undefined,
    });
    expect(result).toEqual({
      approveTxHash: '0xapprovetx',
      callTxHash: '0xcalltx',
      success: true,
    });
  });

  it('wraps approve failures as CONTRACT_CALL_FAILED', async () => {
    vi.mocked(Contract).mockImplementation(() => ({
      approve: vi.fn().mockRejectedValue(new Error('approve reverted')),
    }) as unknown as InstanceType<typeof Contract>);

    const signer = makeMockSigner();
    await expect(
      approveAndCall(
        signer,
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        1n,
        '0x00',
      ),
    ).rejects.toMatchObject({ code: EvalancheErrorCode.CONTRACT_CALL_FAILED });
  });
});

describe('upgradeProxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls upgradeToAndCall and returns tx metadata', async () => {
    const upgradeToAndCall = vi.fn().mockResolvedValue({
      hash: '0xupgradetx',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });
    vi.mocked(Contract).mockImplementation(() => ({
      upgradeToAndCall,
    }) as unknown as InstanceType<typeof Contract>);

    const signer = makeMockSigner();
    const result = await upgradeProxy(
      signer,
      '0xcccccccccccccccccccccccccccccccccccccccc',
      '0xdddddddddddddddddddddddddddddddddddddddd',
      '0x1234',
    );

    expect(upgradeToAndCall).toHaveBeenCalledWith(
      '0xdddddddddddddddddddddddddddddddddddddddd',
      '0x1234',
    );
    expect(result).toEqual({ txHash: '0xupgradetx', success: true });
  });

  it('uses 0x initData by default', async () => {
    const upgradeToAndCall = vi.fn().mockResolvedValue({
      hash: '0xupgradetx2',
      wait: vi.fn().mockResolvedValue({ status: 1 }),
    });
    vi.mocked(Contract).mockImplementation(() => ({
      upgradeToAndCall,
    }) as unknown as InstanceType<typeof Contract>);

    const signer = makeMockSigner();
    await upgradeProxy(
      signer,
      '0xcccccccccccccccccccccccccccccccccccccccc',
      '0xdddddddddddddddddddddddddddddddddddddddd',
    );

    expect(upgradeToAndCall).toHaveBeenCalledWith(
      '0xdddddddddddddddddddddddddddddddddddddddd',
      '0x',
    );
  });
});
