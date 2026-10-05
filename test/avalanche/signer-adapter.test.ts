import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const account = {
    getXPAddress: vi.fn((chain: string, hrp: string) => `${chain}-${hrp}-address`),
    getEVMAddress: vi.fn(() => '0x0000000000000000000000000000000000000001'),
    xpAccount: { signTransaction: vi.fn(async () => '0xsignature') },
  };
  const client = {
    sendXPTransaction: vi.fn(async ({ tx }: { tx: string }) => ({ txHash: `sent:${tx}` })),
    xChain: {
      prepareExportTxn: vi.fn(async () => ({ tx: 'x-export', chainAlias: 'X' })),
      prepareImportTxn: vi.fn(async () => ({ tx: 'x-import', chainAlias: 'X' })),
    },
    pChain: {
      prepareExportTxn: vi.fn(async () => ({ tx: 'p-export', chainAlias: 'P' })),
      prepareImportTxn: vi.fn(async () => ({ tx: 'p-import', chainAlias: 'P' })),
      prepareAddPermissionlessDelegatorTxn: vi.fn(async () => ({ tx: 'delegate', chainAlias: 'P' })),
    },
    cChain: {
      prepareExportTxn: vi.fn(async () => ({ tx: 'c-export', chainAlias: 'C' })),
      prepareImportTxn: vi.fn(async () => ({ tx: 'c-import', chainAlias: 'C' })),
    },
  };
  return { account, client };
});

vi.mock('@avalanche-sdk/client', () => ({
  createAvalancheWalletClient: vi.fn(() => sdk.client),
}));
vi.mock('@avalanche-sdk/client/accounts', () => ({
  mnemonicsToAvalancheAccount: vi.fn(() => sdk.account),
}));

import { createAvalancheSigner } from '../../src/avalanche/signer';

describe('Avalanche SDK signing adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps X/P/C exports and imports to destination-owned addresses', async () => {
    const signer = createAvalancheSigner('test mnemonic', {
      network: 'fuji', hrp: 'fuji', networkID: 5, chainId: 43113,
    } as any);

    await expect(signer.exportX(10n, 'P')).resolves.toBe('sent:x-export');
    expect(sdk.client.xChain.prepareExportTxn).toHaveBeenCalledWith({
      destinationChain: 'P',
      exportedOutputs: [{ addresses: ['P-fuji-address'], amount: 10n }],
    });
    await expect(signer.importX('C')).resolves.toBe('sent:x-import');
    expect(sdk.client.xChain.prepareImportTxn).toHaveBeenCalledWith({
      sourceChain: 'C', importedOutput: { addresses: ['X-fuji-address'] },
    });

    await expect(signer.exportP(20n, 'C')).resolves.toBe('sent:p-export');
    expect(sdk.client.pChain.prepareExportTxn).toHaveBeenCalledWith({
      destinationChain: 'C',
      exportedOutputs: [{ addresses: ['C-fuji-address'], amount: 20n }],
    });
    await expect(signer.importP('X')).resolves.toBe('sent:p-import');
    expect(sdk.client.pChain.prepareImportTxn).toHaveBeenCalledWith({
      sourceChain: 'X', importedOutput: { addresses: ['P-fuji-address'] },
    });

    await expect(signer.exportC(30n, 'X')).resolves.toBe('sent:c-export');
    expect(sdk.client.cChain.prepareExportTxn).toHaveBeenCalledWith({
      destinationChain: 'X',
      fromAddress: '0x0000000000000000000000000000000000000001',
      exportedOutput: { addresses: ['X-fuji-address'], amount: 30n },
    });
    await expect(signer.importC('P')).resolves.toBe('sent:c-import');
    expect(sdk.client.cChain.prepareImportTxn).toHaveBeenCalledWith({
      sourceChain: 'P',
      toAddress: '0x0000000000000000000000000000000000000001',
      fromAddresses: ['P-fuji-address'],
    });
  });

  it('maps delegation fields and preserves offline signing', async () => {
    const signer = createAvalancheSigner('test mnemonic', {
      network: 'avalanche', hrp: 'avax', networkID: 1, chainId: 43114,
    } as any);

    await expect(signer.addDelegator('NodeID-1', 25n, 100n, 'P-avax-reward'))
      .resolves.toBe('sent:delegate');
    expect(sdk.client.pChain.prepareAddPermissionlessDelegatorTxn).toHaveBeenCalledWith({
      nodeId: 'NodeID-1',
      stakeInNanoAvax: 25n,
      end: 100n,
      rewardAddresses: ['P-avax-reward'],
      threshold: 1,
    });

    await expect(signer.signXPTransaction(new Uint8Array([1, 2, 3]))).resolves.toBe('0xsignature');
    expect(sdk.account.xpAccount.signTransaction).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });
});
