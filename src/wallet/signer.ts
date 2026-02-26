import { Wallet, HDNodeWallet, JsonRpcProvider, Mnemonic } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** A signer that can be either a Wallet or HDNodeWallet */
export type AgentSigner = Wallet | HDNodeWallet;

/** Result from wallet generation */
export interface GeneratedWallet {
  /** BIP-39 mnemonic phrase (12 words) */
  mnemonic: string;
  /** Hex-encoded private key (with 0x prefix) */
  privateKey: string;
  /** C-Chain address (0x...) */
  address: string;
}

/**
 * Generate a new random wallet with a BIP-39 mnemonic.
 * Uses cryptographically secure randomness via ethers.js.
 * @returns Generated wallet with mnemonic, private key, and address
 */
export function generateWallet(): GeneratedWallet {
  try {
    const wallet = Wallet.createRandom();
    const mnemonic = wallet.mnemonic;
    if (!mnemonic) {
      throw new Error('Failed to generate mnemonic');
    }
    return {
      mnemonic: mnemonic.phrase,
      privateKey: wallet.privateKey,
      address: wallet.address,
    };
  } catch (error) {
    throw new EvalancheError(
      'Failed to generate wallet',
      EvalancheErrorCode.WALLET_ERROR,
      error instanceof Error ? error : undefined,
    );
  }
}

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
