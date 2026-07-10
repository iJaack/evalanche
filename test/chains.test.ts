import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  CHAIN_ALIASES,
  getChainById,
  getChainByAlias,
  getPrimaryRpc,
  getAllChains,
} from '../src/utils/chains';

describe('Chain Registry', () => {
  describe('CHAINS', () => {
    it('should contain all required mainnets', () => {
      const requiredIds = [1, 10, 25, 56, 100, 137, 250, 324, 1284, 4663, 5000, 8453, 42161, 42220, 43114, 59144, 80094, 81457, 534352];
      for (const id of requiredIds) {
        expect(CHAINS[id], `Missing chain ID ${id}`).toBeDefined();
      }
    });

    it('should contain testnets', () => {
      expect(CHAINS[43113]).toBeDefined();
      expect(CHAINS[43113].isTestnet).toBe(true);
      expect(CHAINS[11155111]).toBeDefined();
      expect(CHAINS[11155111].isTestnet).toBe(true);
      expect(CHAINS[84532]).toBeDefined();
      expect(CHAINS[84532].isTestnet).toBe(true);
    });

    it('should have valid chain config structure', () => {
      for (const chain of Object.values(CHAINS)) {
        expect(chain.id).toBeTypeOf('number');
        expect(chain.name).toBeTypeOf('string');
        expect(chain.shortName).toBeTypeOf('string');
        expect(chain.currency.name).toBeTypeOf('string');
        expect(chain.currency.symbol).toBeTypeOf('string');
        expect(chain.currency.decimals).toBe(18);
        expect(chain.rpc.length).toBeGreaterThan(0);
        expect(chain.explorer).toBeTypeOf('string');
      }
    });

    it('should contain Robinhood Chain mainnet with official metadata', () => {
      expect(CHAINS[4663]).toMatchObject({
        id: 4663,
        name: 'Robinhood Chain',
        shortName: 'rh',
        currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        explorer: 'https://robinhoodchain.blockscout.com',
        lifiChainKey: 'out',
      });
      expect(CHAINS[4663].rpc).toContain('https://rpc.mainnet.chain.robinhood.com');
      expect(CHAINS[4663].isTestnet).not.toBe(true);
    });

    it('should expose only Robinhood mainnet', () => {
      expect(CHAIN_ALIASES.robinhood).toBe(4663);
      expect(CHAINS[46630]).toBeUndefined();
      expect(getAllChains(false).some((chain) => chain.id === 4663)).toBe(true);
    });

    it('should include Routescan RPCs for supported chains', () => {
      // Base Routescan RPC currently returns 404/403; keep Base on healthy public endpoints instead.
      const routescanChains = [10, 25, 56, 137, 250, 42161, 43114, 80094];
      for (const id of routescanChains) {
        expect(CHAINS[id].rpc.some(url => url.includes('routescan.io')), `Chain ${id} should have Routescan RPC`).toBe(true);
      }
    });
  });

  describe('CHAIN_ALIASES', () => {
    it('should map all required aliases', () => {
      const requiredAliases = [
        'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc',
        'avalanche', 'fuji', 'fantom', 'gnosis', 'zksync', 'linea',
        'scroll', 'blast', 'mantle', 'celo', 'moonbeam', 'cronos',
        'berachain', 'robinhood', 'sepolia', 'base-sepolia',
      ];
      for (const alias of requiredAliases) {
        expect(CHAIN_ALIASES[alias], `Missing alias: ${alias}`).toBeDefined();
      }
    });

    it('should map to correct chain IDs', () => {
      expect(CHAIN_ALIASES.ethereum).toBe(1);
      expect(CHAIN_ALIASES.base).toBe(8453);
      expect(CHAIN_ALIASES.arbitrum).toBe(42161);
      expect(CHAIN_ALIASES.avalanche).toBe(43114);
      expect(CHAIN_ALIASES.fuji).toBe(43113);
    });
  });

  describe('getChainById', () => {
    it('should return chain config for valid ID', () => {
      const eth = getChainById(1);
      expect(eth).toBeDefined();
      expect(eth!.name).toBe('Ethereum');
      expect(eth!.currency.symbol).toBe('ETH');
    });

    it('should return undefined for unknown ID', () => {
      expect(getChainById(999999)).toBeUndefined();
    });
  });

  describe('getChainByAlias', () => {
    it('should return chain config for valid alias', () => {
      const base = getChainByAlias('base');
      expect(base).toBeDefined();
      expect(base!.id).toBe(8453);
      expect(base!.name).toBe('Base');
    });

    it('should return undefined for unknown alias', () => {
      expect(getChainByAlias('nonexistent')).toBeUndefined();
    });
  });

  describe('getPrimaryRpc', () => {
    it('should return first RPC for known chain', () => {
      const rpc = getPrimaryRpc(43114);
      expect(rpc).toContain('avax.network');
    });

    it('should throw for unknown chain ID', () => {
      expect(() => getPrimaryRpc(999999)).toThrow('Unknown chain ID');
    });
  });

  describe('getAllChains', () => {
    it('should return all chains including testnets by default', () => {
      const all = getAllChains();
      expect(all.length).toBeGreaterThanOrEqual(21);
      expect(all.some(c => c.isTestnet)).toBe(true);
    });

    it('should exclude testnets when flag is false', () => {
      const mainnets = getAllChains(false);
      expect(mainnets.every(c => !c.isTestnet)).toBe(true);
      expect(mainnets.length).toBeLessThan(getAllChains().length);
    });
  });
});
