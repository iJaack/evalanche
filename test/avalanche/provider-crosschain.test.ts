import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Avalanche provider + chain ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches providers by network and exposes contexts', async () => {
    const mod = await import('../../src/avalanche/provider');
    mod.clearProviderCache();
    const a = await mod.createAvalancheProvider('avalanche');
    const b = await mod.createAvalancheProvider('avalanche');
    expect(a).toBe(b);
    expect(a.chainId).toBe(43114);
    expect(a.hrp).toBe('avax');
    expect(mod.getAvalancheContext('fuji').networkID).toBe(5);
  });

  it('wraps X-Chain and P-Chain balance / import-export flows', async () => {
    const { XChainOperations } = await import('../../src/avalanche/xchain');
    const { PChainOperations } = await import('../../src/avalanche/pchain');
    const signer = {
      getCurrentAddress: (chain: string) => `${chain}-addr`,
      exportX: vi.fn(async () => 'sent:export-x'),
      importX: vi.fn(async () => 'sent:import-x'),
      exportP: vi.fn(async () => 'sent:export-p'),
      importP: vi.fn(async () => 'sent:import-p'),
      addDelegator: vi.fn(async () => 'sent:delegate-p'),
    } as any;
    const provider = {
      getXBalance: vi.fn(async () => 12n),
      getPBalance: vi.fn(async () => 12n),
      getPStake: vi.fn(async () => 123n),
      getCurrentValidators: vi.fn(async () => [{ nodeID: 'NodeID-1', stakeAmount: '1', startTime: '1', endTime: '2', delegationFee: '3', uptime: '4', connected: true }]),
      getMinStake: vi.fn(async () => ({ minValidatorStake: 2000n, minDelegatorStake: 25n })),
    } as any;

    const x = new XChainOperations(signer, provider);
    const p = new PChainOperations(signer, provider);
    expect(await x.getBalance()).toBe(12n);
    expect(await p.getBalance()).toBe(12n);
    expect(await x.exportTo(1n, 'P')).toBe('sent:export-x');
    expect(await x.importFrom('P')).toBe('sent:import-x');
    expect(await p.exportTo(1n, 'X')).toBe('sent:export-p');
    expect(await p.importFrom('X')).toBe('sent:import-p');
    expect(await p.addDelegator('NodeID-1', 25n, 1n, 2n)).toBe('sent:delegate-p');
    expect((await p.getStake())[0].staked).toBe('123');
    expect((await p.getCurrentValidators(1))[0].nodeId).toBe('NodeID-1');
    expect((await p.getMinStake()).minDelegatorStake).toBe('25');
  });

  it('orchestrates all cross-chain transfer directions', async () => {
    const { CrossChainTransfer } = await import('../../src/avalanche/crosschain');
    const signer = {
      getCurrentAddress: (chain: string) => `${chain}-addr`,
      getAddressEVM: () => '0x0000000000000000000000000000000000000001',
    } as any;
    const provider = {} as any;

    const transfer = new CrossChainTransfer(signer, provider) as any;
    transfer.xChain = { exportTo: vi.fn(async () => 'exp-x'), importFrom: vi.fn(async () => 'imp-x') };
    transfer.pChain = { exportTo: vi.fn(async () => 'exp-p'), importFrom: vi.fn(async () => 'imp-p') };
    transfer.waitForImportAvailability = vi.fn(async () => undefined);
    transfer.exportFromC = vi.fn(async () => 'exp-c');
    transfer.importToC = vi.fn(async () => 'imp-c');

    expect(await transfer.transfer('X', 'P', 1n)).toEqual({ exportTxId: 'exp-x', importTxId: 'imp-p' });
    expect(await transfer.transfer('X', 'C', 1n)).toEqual({ exportTxId: 'exp-x', importTxId: 'imp-c' });
    expect(await transfer.transfer('P', 'X', 1n)).toEqual({ exportTxId: 'exp-p', importTxId: 'imp-x' });
    expect(await transfer.transfer('P', 'C', 1n)).toEqual({ exportTxId: 'exp-p', importTxId: 'imp-c' });
    expect(await transfer.transfer('C', 'X', 1n)).toEqual({ exportTxId: 'exp-c', importTxId: 'imp-x' });
    expect(await transfer.transfer('C', 'P', 1n)).toEqual({ exportTxId: 'exp-c', importTxId: 'imp-p' });
    await expect(transfer.transfer('C', 'C', 1n)).rejects.toThrow(/must be different/);
  });

  it('polls C-chain import availability at the EVM import address', async () => {
    const { CrossChainTransfer } = await import('../../src/avalanche/crosschain');
    const signer = {
      getCurrentAddress: vi.fn((chain: string) => `${chain}-addr`),
      getAddressEVM: vi.fn(() => '0x0000000000000000000000000000000000000001'),
    } as any;
    const provider = {
      getAtomicUTXOCount: vi.fn(async () => 1),
    } as any;

    const transfer = new CrossChainTransfer(signer, provider) as any;
    await transfer.waitForImportAvailability('C', 'X');

    expect(provider.getAtomicUTXOCount).toHaveBeenCalledWith(
      'C',
      'X',
      '0x0000000000000000000000000000000000000001',
    );
    expect(signer.getCurrentAddress).not.toHaveBeenCalledWith('C');
  });
});
