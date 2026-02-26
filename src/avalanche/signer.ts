import { Avalanche } from '@avalabs/core-wallets-sdk';
import type { AvalancheProvider } from './provider';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Type alias for the Avalanche StaticSigner */
export type AvalancheSigner = InstanceType<typeof Avalanche.StaticSigner>;

/**
 * Create a StaticSigner for multi-VM signing (X-Chain, P-Chain, C-Chain).
 *
 * StaticSigner uses a single key for X/P chains and a single key for C chain.
 * For agents, we derive both from the same mnemonic.
 *
 * @param mnemonic - BIP-39 mnemonic phrase
 * @param provider - Avalanche provider from createAvalancheProvider()
 * @returns StaticSigner instance
 */
export function createAvalancheSigner(
  mnemonic: string,
  provider: AvalancheProvider,
): AvalancheSigner {
  try {
    return Avalanche.StaticSigner.fromMnemonic(
      mnemonic,
      "m/44'/9000'/0'/0/0",
      "m/44'/60'/0'/0/0",
      provider,
    );
  } catch (error) {
    throw new EvalancheError(
      'Failed to create Avalanche signer from mnemonic',
      EvalancheErrorCode.WALLET_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}
