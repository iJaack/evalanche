import { Wallet, HDNodeWallet, JsonRpcProvider } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** A signer that can be either a Wallet or HDNodeWallet */
export type AgentSigner = Wallet | HDNodeWallet;

/**
 * Create a wallet signer from a private key.
 * @param privateKey - Hex-encoded private key
 * @param provider - JSON-RPC provider to connect to
 * @returns Connected ethers Wallet
 */
export function createWalletFromPrivateKey(privateKey: string, provider: JsonRpcProvider): Wallet {
  try {
    return new Wallet(privateKey, provider);
  } catch (error) {
    throw new EvalancheError(
      'Failed to create wallet from private key',
      EvalancheErrorCode.WALLET_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Create a wallet signer from a mnemonic phrase.
 * @param mnemonic - BIP-39 mnemonic phrase
 * @param provider - JSON-RPC provider to connect to
 * @returns Connected HDNodeWallet
 */
export function createWalletFromMnemonic(mnemonic: string, provider: JsonRpcProvider): HDNodeWallet {
  try {
    return Wallet.fromPhrase(mnemonic).connect(provider);
  } catch (error) {
    throw new EvalancheError(
      'Failed to create wallet from mnemonic',
      EvalancheErrorCode.WALLET_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}
