import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Evalanche, EvalancheError, EvalancheErrorCode } from '../src/index';

// A deterministic test private key (DO NOT use in production)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

describe('Evalanche', () => {
  describe('constructor', () => {
    it('should create an agent with a private key', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'fuji',
      });

      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      expect(agent.wallet).toBeDefined();
      expect(agent.provider).toBeDefined();
    });

    it('should create an agent with a mnemonic', () => {
      const agent = new Evalanche({
        mnemonic: TEST_MNEMONIC,
        network: 'fuji',
      });

      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should throw if neither privateKey nor mnemonic is provided', () => {
      expect(() => new Evalanche({ network: 'fuji' })).toThrow(EvalancheError);
      expect(() => new Evalanche({ network: 'fuji' })).toThrow('Either privateKey or mnemonic is required');
    });

    it('should default to avalanche network', () => {
      const agent = new Evalanche({ privateKey: TEST_PRIVATE_KEY });
      expect(agent.provider).toBeDefined();
    });

    it('should support custom network config', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: { rpcUrl: 'http://localhost:8545', chainId: 31337 },
      });

      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should accept identity config', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'fuji',
        identity: {
          agentId: '1599',
          registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        },
      });

      expect(agent.address).toBeDefined();
    });
  });

  describe('resolveIdentity', () => {
    it('should throw if identity config is not provided', async () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'fuji',
      });

      await expect(agent.resolveIdentity()).rejects.toThrow('Identity config not provided');
    });
  });

  describe('signMessage', () => {
    it('should sign a message', async () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'fuji',
      });

      const signature = await agent.signMessage('Hello Evalanche');
      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.startsWith('0x')).toBe(true);
    });

    it('should produce deterministic signatures', async () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'fuji',
      });

      const sig1 = await agent.signMessage('test message');
      const sig2 = await agent.signMessage('test message');
      expect(sig1).toBe(sig2);
    });
  });
});
