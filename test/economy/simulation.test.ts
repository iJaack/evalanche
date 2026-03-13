import { describe, it, expect, vi } from 'vitest';
import { simulateTransaction } from '../../src/economy/simulation';
import type { PendingTransaction } from '../../src/economy/types';
import type { JsonRpcProvider } from 'ethers';

/** Create a mock ethers provider */
function mockProvider(overrides?: {
  callResult?: string;
  callError?: Error;
  estimateResult?: bigint;
  estimateError?: Error;
}): JsonRpcProvider {
  return {
    call: vi.fn().mockImplementation(() => {
      if (overrides?.callError) throw overrides.callError;
      return Promise.resolve(overrides?.callResult ?? '0x');
    }),
    estimateGas: vi.fn().mockImplementation(() => {
      if (overrides?.estimateError) throw overrides.estimateError;
      return Promise.resolve(overrides?.estimateResult ?? 21000n);
    }),
  } as unknown as JsonRpcProvider;
}

const baseTx: PendingTransaction = {
  to: '0x1234567890abcdef1234567890abcdef12345678',
  value: '100000000000000000',
  chainId: 8453,
};

describe('simulateTransaction', () => {
  it('should return success with gas estimate for valid transactions', async () => {
    const provider = mockProvider({ callResult: '0x', estimateResult: 21000n });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(true);
    expect(result.gasEstimate).toBe('21000');
    expect(result.returnData).toBe('0x');
    expect(result.revertReason).toBeUndefined();
  });

  it('should return success even if gas estimation fails', async () => {
    const provider = mockProvider({
      callResult: '0x',
      estimateError: new Error('gas estimation failed'),
    });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(true);
    expect(result.gasEstimate).toBeUndefined();
    expect(result.returnData).toBe('0x');
  });

  it('should return failure with reason when call reverts', async () => {
    const error = Object.assign(new Error('execution reverted'), {
      reason: 'Insufficient balance',
    });
    const provider = mockProvider({ callError: error });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('Insufficient balance');
    expect(result.gasEstimate).toBeUndefined();
  });

  it('should decode Error(string) from raw revert data', async () => {
    // Encode Error("Not enough tokens")
    // Selector: 0x08c379a0
    // Offset: 0x20 (32)
    // Length: 0x11 (17 = "Not enough tokens".length)
    // Data: hex of "Not enough tokens"
    const text = 'Not enough tokens';
    const hexText = Buffer.from(text).toString('hex');
    const data = '0x08c379a0'
      + '0000000000000000000000000000000000000000000000000000000000000020'
      + '0000000000000000000000000000000000000000000000000000000000000011'
      + hexText.padEnd(64, '0');

    const error = Object.assign(new Error('call revert exception'), { data });
    const provider = mockProvider({ callError: error });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('Not enough tokens');
  });

  it('should handle non-standard revert data gracefully', async () => {
    const error = Object.assign(new Error('call revert exception'), {
      data: '0xdeadbeef',
    });
    const provider = mockProvider({ callError: error });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(false);
    expect(result.revertReason).toContain('0xdeadbeef');
  });

  it('should handle plain error messages', async () => {
    const provider = mockProvider({ callError: new Error('network timeout') });
    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('network timeout');
  });

  it('should handle non-Error throws', async () => {
    const provider = {
      call: vi.fn().mockRejectedValue('string error'),
      estimateGas: vi.fn(),
    } as unknown as JsonRpcProvider;

    const result = await simulateTransaction(provider, baseTx);

    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('string error');
  });

  it('should pass correct params to provider', async () => {
    const provider = mockProvider();
    const tx: PendingTransaction = {
      to: '0xaaaa',
      value: '500',
      data: '0xa9059cbb',
      chainId: 1,
      gasLimit: 100000n,
    };

    await simulateTransaction(provider, tx);

    expect(provider.call).toHaveBeenCalledWith({
      to: '0xaaaa',
      value: 500n,
      data: '0xa9059cbb',
      gasLimit: 100000n,
    });
  });
});
