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

    // Set up Contract mock — resolver uses getFunction() pattern (ethers v6)
    const mockIdentityContract = {
      getFunction: vi.fn().mockImplementation((name: string) => {
        if (name === 'tokenURI') return vi.fn().mockResolvedValue('ipfs://QmTest123');
        if (name === 'ownerOf') return vi.fn().mockResolvedValue('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
        return vi.fn().mockRejectedValue(new Error('Unknown function'));
      }),
    };
    const mockReputationContract = {
      getFunction: vi.fn().mockImplementation((name: string) => {
        if (name === 'getReputation') return vi.fn().mockResolvedValue(BigInt(80));
        return vi.fn().mockRejectedValue(new Error('Unknown function'));
      }),
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

    it('should return "unknown" for null score', () => {
      expect(IdentityResolver.deriveTrustLevel(null)).toBe('unknown');
    });
  });

  describe('resolve', () => {
    it('should resolve identity from on-chain data with CAIP-10 format', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity = await resolver.resolve();

      expect(identity.agentId).toBe(TEST_AGENT_ID);
      expect(identity.agentRegistry).toBe(`eip155:43114:${TEST_REGISTRY}`);
      expect(identity.owner).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
      expect(identity.metadataUri).toBe('ipfs://QmTest123');
      expect(identity.reputationScore).toBe(80);
      expect(identity.trustLevel).toBe('high');
    });

    it('should accept CAIP-10 registry format directly', async () => {
      const caip10Registry = `eip155:43114:${TEST_REGISTRY}`;
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: caip10Registry,
      });

      const identity = await resolver.resolve();
      expect(identity.agentRegistry).toBe(caip10Registry);
    });

    it('should cache results', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity1 = await resolver.resolve();
      const identity2 = await resolver.resolve();

      expect(identity1).toEqual(identity2);
    });

    it('should use default registry with CAIP-10 format if not provided', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
      });

      const identity = await resolver.resolve();
      expect(identity.agentRegistry).toBe(`eip155:43114:${TEST_REGISTRY}`);
    });

    it('should return null fields when individual calls fail', async () => {
      // Override with failing mocks
      const mockIdentityContract = {
        getFunction: vi.fn().mockImplementation(() => {
          return vi.fn().mockRejectedValue(new Error('Network error'));
        }),
      };
      const mockReputationContract = {
        getFunction: vi.fn().mockImplementation(() => {
          return vi.fn().mockRejectedValue(new Error('Network error'));
        }),
      };

      let callCount = 0;
      vi.mocked(Contract).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockIdentityContract as unknown as Contract;
        return mockReputationContract as unknown as Contract;
      });

      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity = await resolver.resolve();

      expect(identity.metadataUri).toBeNull();
      expect(identity.owner).toBeNull();
      expect(identity.reputationScore).toBeNull();
      expect(identity.trustLevel).toBe('unknown');
    });

    it('should clamp reputation score to 0-100 range', async () => {
      const mockIdentityContract = {
        getFunction: vi.fn().mockImplementation((name: string) => {
          if (name === 'tokenURI') return vi.fn().mockResolvedValue('ipfs://test');
          if (name === 'ownerOf') return vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000001');
          return vi.fn().mockRejectedValue(new Error('Unknown'));
        }),
      };
      const mockReputationContract = {
        getFunction: vi.fn().mockImplementation(() => {
          return vi.fn().mockResolvedValue(BigInt(150)); // Over 100
        }),
      };

      let callCount = 0;
      vi.mocked(Contract).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return mockIdentityContract as unknown as Contract;
        return mockReputationContract as unknown as Contract;
      });

      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
      });

      const identity = await resolver.resolve();
      expect(identity.reputationScore).toBe(100);
    });

    it('should support custom chainId for CAIP-10', async () => {
      const resolver = new IdentityResolver(mockProvider, {
        agentId: TEST_AGENT_ID,
        registry: TEST_REGISTRY,
        chainId: 43113, // Fuji
      });

      const identity = await resolver.resolve();
      expect(identity.agentRegistry).toBe(`eip155:43113:${TEST_REGISTRY}`);
    });
  });
});
