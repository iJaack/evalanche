import { describe, expect, it, vi } from 'vitest';
import { Evalanche } from '../../src/agent';

const TARGET = '0x1000000000000000000000000000000000000001';

describe('pre-send simulation', () => {
  it('simulates as the agent with the real calldata when simulateBeforeSend is on', async () => {
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, network: 'fuji', policy: { simulateBeforeSend: true } });
    const call = vi.spyOn(agent.provider, 'call').mockResolvedValue('0x');
    vi.spyOn(agent.provider, 'estimateGas').mockResolvedValue(21_000n);
    try {
      await agent.authorizeTransaction({ to: TARGET, data: '0x12345678' });
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ from: agent.address, to: TARGET, data: '0x12345678' }));
    } finally {
      agent.provider.destroy();
    }
  });

  it('simulateTransaction also runs as the agent', async () => {
    const agent = new Evalanche({ privateKey: `0x${'1'.repeat(64)}`, network: 'fuji' });
    const call = vi.spyOn(agent.provider, 'call').mockResolvedValue('0x');
    vi.spyOn(agent.provider, 'estimateGas').mockResolvedValue(21_000n);
    try {
      await agent.simulateTransaction({ to: TARGET, data: '0xabcdef01' });
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ from: agent.address, data: '0xabcdef01' }));
    } finally {
      agent.provider.destroy();
    }
  });
});
