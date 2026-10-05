import { createAvalancheWalletClient } from '@avalanche-sdk/client';
import { mnemonicsToAvalancheAccount } from '@avalanche-sdk/client/accounts';
import { avalanche, avalancheFuji } from 'viem/chains';
import type { AvalancheProvider } from './provider';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export interface AvalancheSigner {
  readonly hrp: 'avax' | 'fuji';
  getCurrentAddress(chain: 'X' | 'P' | 'C'): string;
  getAddressEVM(): string;
  signXPTransaction(payload: Uint8Array): Promise<string>;
  exportX(amount: bigint, destination: 'P' | 'C'): Promise<string>;
  importX(source: 'P' | 'C'): Promise<string>;
  exportP(amount: bigint, destination: 'X' | 'C'): Promise<string>;
  importP(source: 'X' | 'C'): Promise<string>;
  addDelegator(nodeId: string, stakeAmount: bigint, end: bigint, rewardAddress: string): Promise<string>;
  exportC(amount: bigint, destination: 'X' | 'P'): Promise<string>;
  importC(source: 'X' | 'P'): Promise<string>;
}

/**
 * Create a local Avalanche account and wallet client from a BIP-39 mnemonic.
 */
export function createAvalancheSigner(
  mnemonic: string,
  provider: AvalancheProvider,
): AvalancheSigner {
  try {
    // The SDK defaults match the established Evalanche derivation paths:
    // EVM m/44'/60'/0'/0/0 and X/P m/44'/9000'/0'/0/0.
    const account = mnemonicsToAvalancheAccount(mnemonic);
    const client = createAvalancheWalletClient({
      account,
      chain: provider.network === 'avalanche' ? avalanche : avalancheFuji,
      transport: { type: 'http' },
    });
    const getCurrentAddress = (chain: 'X' | 'P' | 'C') => (
      account.getXPAddress(chain, provider.hrp)
    );
    const send = async (prepared: Parameters<typeof client.sendXPTransaction>[0]) => (
      await client.sendXPTransaction(prepared)
    ).txHash;

    return {
      hrp: provider.hrp,
      getCurrentAddress,
      getAddressEVM: () => account.getEVMAddress(),
      signXPTransaction: async (payload) => account.xpAccount!.signTransaction(payload),
      exportX: async (amount, destination) => send(
        await client.xChain.prepareExportTxn({
          destinationChain: destination,
          exportedOutputs: [{ addresses: [getCurrentAddress(destination)], amount }],
        }),
      ),
      importX: async (source) => send(
        await client.xChain.prepareImportTxn({
          sourceChain: source,
          importedOutput: { addresses: [getCurrentAddress('X')] },
        }),
      ),
      exportP: async (amount, destination) => send(
        await client.pChain.prepareExportTxn({
          destinationChain: destination,
          exportedOutputs: [{ addresses: [getCurrentAddress(destination)], amount }],
        }),
      ),
      importP: async (source) => send(
        await client.pChain.prepareImportTxn({
          sourceChain: source,
          importedOutput: { addresses: [getCurrentAddress('P')] },
        }),
      ),
      addDelegator: async (nodeId, stakeAmount, end, rewardAddress) => send(
        await client.pChain.prepareAddPermissionlessDelegatorTxn({
          nodeId,
          stakeInNanoAvax: stakeAmount,
          end,
          rewardAddresses: [rewardAddress],
          threshold: 1,
        }),
      ),
      exportC: async (amount, destination) => send(
        await client.cChain.prepareExportTxn({
          destinationChain: destination,
          fromAddress: account.getEVMAddress(),
          exportedOutput: { addresses: [getCurrentAddress(destination)], amount },
        }),
      ),
      importC: async (source) => send(
        await client.cChain.prepareImportTxn({
          sourceChain: source,
          toAddress: account.getEVMAddress(),
          fromAddresses: [getCurrentAddress(source)],
        }),
      ),
    };
  } catch (error) {
    throw new EvalancheError(
      'Failed to create Avalanche signer from mnemonic',
      EvalancheErrorCode.WALLET_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}
