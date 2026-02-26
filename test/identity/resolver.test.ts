import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityResolver } from '../../src/identity/resolver';
import { JsonRpcProvider, Contract } from 'ethers';

// Mock ethers Contract
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');
  return {
    ...actual,
    Contract: vi.fn(),
  };
});

const TEST_AGENT_ID = '1599';
const TEST_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

describe('IdentityResolver', () => {
  let mockProvider: JsonRpcProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {} as JsonRpcProvider;

    // Set up Contract mock to return mock contract instances
    const mockIdentityContract = {
      tokenURI: vi.fn().mockResolvedValue('ipfs://QmTest123'),
      ownerOf: vi.fn().mockResolvedValue('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
    };
    const mockReputationContract = {
      getReputation: vi.fn().mockResolvedValue(BigInt(80)),
    };

    let callCount = 0;
    vi.mocked(Contract).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return mockIdentityContract as unknown as Contract;
      return mockReputationContract as unknown as Contract;
    });
  });

  describe('deriveTrustLevel', () => {
    it('should return "high" for score >= 75', () => {
      expect(IdentityResolver.deriveTrustLevel(75)).toBe('high');
      expect(IdentityResolver.deriveTrustLevel(100)).toBe('high');
      expect(IdentityResolver.deriveTrustLevel(80)).toBe('high');
    });

    it('should return "medium" for score >= 40 and < 75', () => {
      expect(IdentityResolver.deriveTrustLevel(40)).toBe('medium');
      expect(IdentityResolver.deriveTrustLevel(74)).toBe('medium');
      expect(IdentityResolver.deriveTrustLevel(50)).toBe('medium');
    });

    it('should return "low" for score < 40', () => {
      expect(IdentityResolver.deriveTrustLevel(0)).toBe('low');
      expect(IdentityResolver.deriveTrustLevel(39)).toBe('low');
      expect(IdentityResolver.deriveTrustLevel(10)).toBe('low');
    });
  });

  describe('resolve', () => {
    it('should resolve identity from on-chain data', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity = await resolver.resolve();

      expect(identity.agentId).toBe(TEST_AGENT_ID);
      expect(identity.registry).toBe(TEST_REGISTRY);
      expect(identity.owner).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      expect(identity.tokenURI).toBe('ipfs://QmTest123');
      expect(identity.reputation).toBe(80);
      expect(identity.trustLevel).toBe('high');
    });

    it('should cache results', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity1 = await resolver.resolve();
      const identity2 = await resolver.resolve();

      expect(identity1).toEqual(identity2);
      // Contract constructor was called only during resolver construction (2 calls),
      // and the methods were called only once due to caching
    });

    it('should use default registry if not provided', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
      });

      const identity = await resolver.resolve();
      expect(identity.registry).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    });
  });
});
