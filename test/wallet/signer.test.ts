import { describe, it, expect, vi } from 'vitest';
import { createWalletFromPrivateKey, createWalletFromMnemonic } from '../../src/wallet/signer';
import { JsonRpcProvider } from 'ethers';
import { EvalancheError } from '../../src/utils/errors';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const EXPECTED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('wallet/signer', () => {
  const mockProvider = new JsonRpcProvider('http://localhost:8545');

  describe('createWalletFromPrivateKey', () => {
    it('should create a wallet from a valid private key', () => {
      const wallet = createWalletFromPrivateKey(TEST_PRIVATE_KEY, mockProvider);
      expect(wallet.address).toBe(EXPECTED_ADDRESS);
    });

    it('should throw EvalancheError for invalid private key', () => {
      expect(() => createWalletFromPrivateKey('invalid', mockProvider)).toThrow(EvalancheError);
    });
  });

  describe('createWalletFromMnemonic', () => {
    it('should create a wallet from a valid mnemonic', () => {
      const wallet = createWalletFromMnemonic(TEST_MNEMONIC, mockProvider);
      expect(wallet.address).toBe(EXPECTED_ADDRESS);
    });

    it('should throw EvalancheError for invalid mnemonic', () => {
      expect(() => createWalletFromMnemonic('invalid mnemonic phrase', mockProvider)).toThrow(EvalancheError);
    });
  });
});
