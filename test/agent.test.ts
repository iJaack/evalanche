import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Evalanche, EvalancheError, EvalancheErrorCode, generateWallet } from '../src/index';

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

  describe('multi-chain network support', () => {
    it('should create agent on Ethereum', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'ethereum',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should create agent on Base', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should create agent on Arbitrum', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'arbitrum',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should create agent on Optimism', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'optimism',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should create agent on Polygon', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'polygon',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should create agent on BSC', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'bsc',
      });
      expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    });

    it('should throw for unknown network name', () => {
      expect(() => new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        // @ts-expect-error Testing invalid network
        network: 'nonexistent',
      })).toThrow('Unknown network');
    });

    it('should support rpcOverride', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'ethereum',
        rpcOverride: 'http://localhost:8545',
      });
      expect(agent.address).toBeDefined();
    });
  });

  describe('getChainInfo', () => {
    it('should return full chain config for known chain', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'base',
      });

      const info = agent.getChainInfo();
      expect('currency' in info).toBe(true);
      if ('currency' in info) {
        expect(info.name).toBe('Base');
        expect(info.id).toBe(8453);
        expect(info.currency.symbol).toBe('ETH');
      }
    });

    it('should return basic info for custom network', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: { rpcUrl: 'http://localhost:8545', chainId: 31337 },
      });

      const info = agent.getChainInfo();
      expect(info.id).toBe(31337);
    });
  });

  describe('switchNetwork', () => {
    it('should return new agent on different network', () => {
      const agent = new Evalanche({
        privateKey: TEST_PRIVATE_KEY,
        network: 'ethereum',
      });

      const baseAgent = agent.switchNetwork('base');
      expect(baseAgent.address).toBe(agent.address);

      const baseInfo = baseAgent.getChainInfo();
      expect('currency' in baseInfo && baseInfo.name).toBe('Base');
    });
  });

  describe('getSupportedChains (static)', () => {
    it('should return all supported chains', () => {
      const chains = Evalanche.getSupportedChains();
      expect(chains.length).toBeGreaterThanOrEqual(21);
    });

    it('should filter out testnets', () => {
      const mainnets = Evalanche.getSupportedChains(false);
      expect(mainnets.every(c => !c.isTestnet)).toBe(true);
    });
  });

  describe('generate (static factory)', () => {
    it('should generate a new agent with a random wallet', () => {
      const { agent, wallet } = Evalanche.generate({ network: 'fuji' });

      expect(agent).toBeInstanceOf(Evalanche);
      expect(agent.address).toBe(wallet.address);
      expect(wallet.mnemonic).toBeDefined();
      expect(wallet.mnemonic.split(' ')).toHaveLength(12);
      expect(wallet.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should generate unique wallets each time', () => {
      const { wallet: w1 } = Evalanche.generate({ network: 'fuji' });
      const { wallet: w2 } = Evalanche.generate({ network: 'fuji' });

      expect(w1.address).not.toBe(w2.address);
      expect(w1.mnemonic).not.toBe(w2.mnemonic);
      expect(w1.privateKey).not.toBe(w2.privateKey);
    });

    it('should work with no options (defaults to avalanche mainnet)', () => {
      const { agent, wallet } = Evalanche.generate();

      expect(agent.address).toBe(wallet.address);
      expect(agent.provider).toBeDefined();
    });

    it('should pass through identity and multiVM options', () => {
      const { agent } = Evalanche.generate({
        network: 'fuji',
        identity: {
          agentId: '1599',
          registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
        },
        multiVM: true,
      });

      expect(agent.address).toBeDefined();
    });

    it('should work with non-Avalanche chains', () => {
      const { agent, wallet } = Evalanche.generate({ network: 'base' });
      expect(agent.address).toBe(wallet.address);
    });
  });

  describe('generateWallet (standalone)', () => {
    it('should return mnemonic, privateKey, and address', () => {
      const w = generateWallet();

      expect(w.mnemonic.split(' ')).toHaveLength(12);
      expect(w.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
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
