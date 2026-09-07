import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDefaultMainnetProvider = vi.fn();
const getDefaultFujiProvider = vi.fn();

vi.mock('../../src/avalanche/sdk', () => ({
  loadAvalancheSdk: () => ({
    JsonRpcProvider: {
      getDefaultMainnetProvider,
      getDefaultFujiProvider,
    },
    MainnetContext: { networkID: 1 },
    FujiContext: { networkID: 5 },
  }),
}));

describe('Avalanche provider + chain ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches providers by network and exposes contexts', async () => {
    const provider = { kind: 'mainnet' } as any;
    getDefaultMainnetProvider.mockReturnValue(provider);
    const mod = await import('../../src/avalanche/provider');
    mod.clearProviderCache();
    const a = await mod.createAvalancheProvider('avalanche');
    const b = await mod.createAvalancheProvider('avalanche');
    expect(a).toBe(provider);
    expect(b).toBe(provider);
    expect(getDefaultMainnetProvider).toHaveBeenCalledTimes(1);
    expect(mod.getAvalancheContext('fuji').networkID).toBe(5);
  });

  it('wraps X-Chain and P-Chain balance / import-export flows', async () => {
    const { XChainOperations } = await import('../../src/avalanche/xchain');
    const { PChainOperations } = await import('../../src/avalanche/pchain');
    const utxo = (asset: string, amount: bigint) => ({ getAssetId: () => asset, output: { amount: () => amount } });
    const atomicSet = (items: any[]) => ({ getUTXOs: () => items });
    const signer = {
      getCurrentAddress: (chain: string) => `${chain}-addr`,
      getUTXOs: vi.fn(async () => atomicSet([utxo('avax', 5n), utxo('other', 1n), utxo('avax', 7n)])),
      getAtomicUTXOs: vi.fn(async () => atomicSet([utxo('avax', 2n)])),
      exportX: vi.fn(() => 'unsignedX'),
      importX: vi.fn(() => 'unsignedImportX'),
      exportP: vi.fn(() => 'unsignedP'),
      importP: vi.fn(() => 'unsignedImportP'),
      addDelegator: vi.fn(() => 'unsignedDel'),
      signTx: vi.fn(async ({ tx }) => ({ getSignedTx: () => `signed:${tx}` })),
      getStake: vi.fn(async () => ({ staked: 123n })),
    } as any;
    const provider = {
      getContext: () => ({ avaxAssetID: 'avax' }),
      getApiX: () => ({ issueSignedTx: vi.fn(async () => ({ txID: 'tx-x' })) }),
      getApiP: () => ({
        issueSignedTx: vi.fn(async () => ({ txID: 'tx-p' })),
        getCurrentValidators: vi.fn(async () => ({ validators: [{ nodeID: 'NodeID-1', stakeAmount: '1', startTime: 1, endTime: 2, delegationFee: 3, uptime: 4, connected: true }] })),
        getMinStake: vi.fn(async () => ({ minValidatorStake: 2000n, minDelegatorStake: 25n })),
      }),
    } as any;

    const x = new XChainOperations(signer, provider);
    const p = new PChainOperations(signer, provider);
    expect(await x.getBalance()).toBe(12n);
    expect(await p.getBalance()).toBe(12n);
    expect(await x.exportTo(1n, 'P')).toBe('tx-x');
    expect(await x.importFrom('P')).toBe('tx-x');
    expect(await p.exportTo(1n, 'X')).toBe('tx-p');
    expect(await p.importFrom('X')).toBe('tx-p');
    expect((await p.getStake())[0].staked).toBe('123');
    expect((await p.getCurrentValidators(1))[0].nodeId).toBe('NodeID-1');
    expect((await p.getMinStake()).minDelegatorStake).toBe('25');
  });

  it('orchestrates all cross-chain transfer directions', async () => {
    const { CrossChainTransfer } = await import('../../src/avalanche/crosschain');
    const signer = {
      getNonce: vi.fn(async () => 1),
      exportC: vi.fn(() => 'unsignedCExport'),
      importC: vi.fn(() => 'unsignedCImport'),
      getAtomicUTXOs: vi.fn(async () => ({ getUTXOs: () => [1] })),
      signTx: vi.fn(async ({ tx }) => ({ getSignedTx: () => `signed:${tx}` })),
    } as any;
    const provider = {
      evmRpc: { getFeeData: vi.fn(async () => ({ gasPrice: 1n })) },
      getApiC: () => ({ issueSignedTx: vi.fn(async () => ({ txID: 'tx-c' })) }),
      getApiX: () => ({ issueSignedTx: vi.fn(async () => ({ txID: 'tx-x' })) }),
      getApiP: () => ({ issueSignedTx: vi.fn(async () => ({ txID: 'tx-p' })) }),
    } as any;

    const transfer = new CrossChainTransfer(signer, provider) as any;
    transfer.xChain = { exportTo: vi.fn(async () => 'exp-x'), importFrom: vi.fn(async () => 'imp-x') };
    transfer.pChain = { exportTo: vi.fn(async () => 'exp-p'), importFrom: vi.fn(async () => 'imp-p') };
    transfer.waitForConfirmation = vi.fn(async () => undefined);
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
});
