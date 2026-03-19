import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRegistration } from '../../src/interop/schemas';

// Sample registration file used across tests
const SAMPLE_REGISTRATION: AgentRegistration = {
  name: 'TestAgent',
  description: 'A test agent for unit testing',
  agentWallet: '0xWalletAddress1234567890abcdef1234567890ab',
  active: true,
  services: [
    { name: 'web', endpoint: 'https://agent.example.com', version: '1.0' },
    { name: 'A2A', endpoint: 'https://agent.example.com/a2a' },
    { name: 'MCP', endpoint: 'https://agent.example.com/mcp' },
  ],
  x402Support: true,
  supportedTrust: ['reputation', 'crypto-economic'],
  registrations: [
    { agentRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '1599' },
  ],
};

// Track the contract constructor calls so we can control behavior per-test
let contractFactory: (...args: unknown[]) => Record<string, unknown>;

vi.mock('ethers', () => {
  return {
    Contract: vi.fn((...args: unknown[]) => contractFactory(...args)),
    JsonRpcProvider: vi.fn().mockReturnValue({}),
  };
});

// Must import AFTER vi.mock
import { InteropIdentityResolver } from '../../src/interop/identity';
import { Contract, JsonRpcProvider } from 'ethers';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeContract(overrides: {
  getFunction?: ReturnType<typeof vi.fn>;
  queryFilter?: ReturnType<typeof vi.fn>;
}): Record<string, unknown> {
  return {
    getFunction: overrides.getFunction ?? vi.fn(),
    queryFilter: overrides.queryFilter ?? vi.fn().mockResolvedValue([]),
    filters: { Transfer: vi.fn().mockReturnValue('transfer-filter') },
  };
}

describe('InteropIdentityResolver', () => {
  let resolver: InteropIdentityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default factory: tokenURI returns a URL
    contractFactory = () => makeContract({
      getFunction: vi.fn().mockReturnValue(vi.fn().mockResolvedValue('https://default.example.com/reg.json')),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);
  });

  // Helper: set up contract to return a specific tokenURI and re-create resolver
  function setupTokenURI(uri: string): void {
    contractFactory = () => makeContract({
      getFunction: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(uri)),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);
  }

  // Helper: mock fetch to return JSON
  function mockFetchJSON(data: unknown): void {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  // ── resolveAgent with https:// URI ──

  it('resolves agent with https:// URI', async () => {
    setupTokenURI('https://agent.example.com/registration.json');
    mockFetchJSON(SAMPLE_REGISTRATION);

    const result = await resolver.resolveAgent(1599);
    expect(result.name).toBe('TestAgent');
    expect(result.services).toHaveLength(3);
    expect(result.agentWallet).toBe('0xWalletAddress1234567890abcdef1234567890ab');
    expect(result.active).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://agent.example.com/registration.json', expect.any(Object));
  });

  // ── resolveAgent with data: URI (base64) ──

  it('resolves agent with data: URI (base64 encoded JSON)', async () => {
    const b64 = Buffer.from(JSON.stringify(SAMPLE_REGISTRATION)).toString('base64');
    setupTokenURI(`data:application/json;base64,${b64}`);

    const result = await resolver.resolveAgent('1599');
    expect(result.name).toBe('TestAgent');
    expect(result.services).toHaveLength(3);
    expect(result.x402Support).toBe(true);
  });

  // ── resolveAgent with data: URI (plain text) ──

  it('resolves agent with data: URI (plain text)', async () => {
    setupTokenURI(`data:application/json,${encodeURIComponent(JSON.stringify(SAMPLE_REGISTRATION))}`);

    const result = await resolver.resolveAgent(1599);
    expect(result.name).toBe('TestAgent');
  });

  // ── resolveAgent with ipfs:// URI ──

  it('resolves agent with ipfs:// URI', async () => {
    const ipfsCid = 'QmTestCid12345';
    setupTokenURI(`ipfs://${ipfsCid}`);
    mockFetchJSON(SAMPLE_REGISTRATION);

    const result = await resolver.resolveAgent(1599);
    expect(result.name).toBe('TestAgent');
    expect(mockFetch).toHaveBeenCalledWith(`https://ipfs.io/ipfs/${ipfsCid}`, expect.any(Object));
  });

  // ── getServiceEndpoints ──

  it('getServiceEndpoints returns typed services', async () => {
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(SAMPLE_REGISTRATION);

    const services = await resolver.getServiceEndpoints(1599);
    expect(services).toHaveLength(3);
    expect(services[0].name).toBe('web');
    expect(services[1].name).toBe('A2A');
    expect(services[2].name).toBe('MCP');
    expect(services[0].endpoint).toBe('https://agent.example.com');
  });

  // ── getPreferredTransport priority order ──

  it('getPreferredTransport returns A2A when available', async () => {
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(SAMPLE_REGISTRATION);

    const preferred = await resolver.getPreferredTransport(1599);
    expect(preferred).not.toBeNull();
    expect(preferred!.transport).toBe('A2A');
    expect(preferred!.endpoint).toBe('https://agent.example.com/a2a');
  });

  it('getPreferredTransport returns MCP when A2A and XMTP are unavailable', async () => {
    const regWithoutA2A: AgentRegistration = {
      ...SAMPLE_REGISTRATION,
      services: [
        { name: 'MCP', endpoint: 'https://agent.example.com/mcp' },
        { name: 'web', endpoint: 'https://agent.example.com' },
      ],
    };
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(regWithoutA2A);

    const preferred = await resolver.getPreferredTransport(1599);
    expect(preferred!.transport).toBe('MCP');
  });

  it('getPreferredTransport returns null for agent with no services', async () => {
    const regNoServices: AgentRegistration = {
      ...SAMPLE_REGISTRATION,
      services: [],
    };
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(regNoServices);

    const preferred = await resolver.getPreferredTransport(1599);
    expect(preferred).toBeNull();
  });

  // ── resolveAgentWallet ──

  it('resolveAgentWallet from on-chain metadata', async () => {
    contractFactory = () => makeContract({
      getFunction: vi.fn().mockReturnValue(vi.fn().mockResolvedValue('0xOnChainWallet')),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);

    const wallet = await resolver.resolveAgentWallet(1599);
    expect(wallet).toBe('0xOnChainWallet');
  });

  it('resolveAgentWallet falls back to registration file', async () => {
    let callCount = 0;
    contractFactory = () => {
      callCount++;
      if (callCount === 1) {
        return makeContract({
          getFunction: vi.fn().mockReturnValue(vi.fn().mockRejectedValue(new Error('no metadata'))),
        });
      }
      return makeContract({
        getFunction: vi.fn().mockReturnValue(vi.fn().mockResolvedValue('https://agent.example.com/reg.json')),
      });
    };
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);

    mockFetchJSON(SAMPLE_REGISTRATION);

    const wallet = await resolver.resolveAgentWallet(1599);
    expect(wallet).toBe('0xWalletAddress1234567890abcdef1234567890ab');
  });

  // ── verifyEndpointBinding ──

  it('verifyEndpointBinding succeeds when well-known matches', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        registrations: [
          { agentRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '1599' },
        ],
      }),
    });

    const result = await resolver.verifyEndpointBinding(1599, 'https://agent.example.com/api');
    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith('https://agent.example.com/.well-known/agent-registration.json', expect.any(Object));
  });

  it('verifyEndpointBinding fails when domain has no match', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        registrations: [
          { agentRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', agentId: '9999' },
        ],
      }),
    });

    const result = await resolver.verifyEndpointBinding(1599, 'https://agent.example.com/api');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('No matching registration');
  });

  it('verifyEndpointBinding fails on invalid URL', async () => {
    const result = await resolver.verifyEndpointBinding(1599, 'not-a-url');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('Invalid endpoint URL');
  });

  it('verifyEndpointBinding fails when well-known returns 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await resolver.verifyEndpointBinding(1599, 'https://agent.example.com/api');
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('404');
  });

  it('verifyEndpointBinding handles CAIP-10 registry format matching', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        registrations: [
          { agentRegistry: 'eip155:43114:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432', agentId: '1599' },
        ],
      }),
    });

    const result = await resolver.verifyEndpointBinding(1599, 'https://agent.example.com/api');
    expect(result.verified).toBe(true);
  });

  // ── resolveByWallet ──

  it('resolveByWallet finds agent from Transfer events', async () => {
    contractFactory = () => makeContract({
      getFunction: vi.fn(),
      queryFilter: vi.fn().mockResolvedValue([
        { args: ['0x0000', '0xTargetWallet', BigInt(42)] },
      ]),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);

    const agentId = await resolver.resolveByWallet('0xTargetWallet');
    expect(agentId).toBe('42');
  });

  it('resolveByWallet returns null when no events found', async () => {
    contractFactory = () => makeContract({
      getFunction: vi.fn(),
      queryFilter: vi.fn().mockResolvedValue([]),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);

    const agentId = await resolver.resolveByWallet('0xUnknownWallet');
    expect(agentId).toBeNull();
  });

  // ── Error cases ──

  it('throws AGENT_NOT_FOUND when tokenURI call fails', async () => {
    contractFactory = () => makeContract({
      getFunction: vi.fn().mockReturnValue(vi.fn().mockRejectedValue(new Error('execution reverted'))),
    });
    const provider = new JsonRpcProvider() as unknown as ConstructorParameters<typeof InteropIdentityResolver>[0];
    resolver = new InteropIdentityResolver(provider);

    await expect(resolver.resolveAgent(99999)).rejects.toThrow('not found');
  });

  it('throws UNSUPPORTED_URI_SCHEME for ftp:// URI', async () => {
    setupTokenURI('ftp://bad-scheme.example.com/reg.json');
    await expect(resolver.resolveAgent(1599)).rejects.toThrow('Unsupported URI scheme');
  });

  it('throws when registration JSON is invalid', async () => {
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('not valid json{{{'),
    });
    await expect(resolver.resolveAgent(1599)).rejects.toThrow('Failed to parse');
  });

  it('throws when HTTP fetch returns error status', async () => {
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(resolver.resolveAgent(1599)).rejects.toThrow('HTTP 500');
  });

  it('throws when data: URI has no comma', async () => {
    setupTokenURI('data:application/json');
    await expect(resolver.resolveAgent(1599)).rejects.toThrow('missing comma');
  });

  it('resolves agent with custom registry address', async () => {
    const customRegistry = '0xCustomRegistry1234567890abcdef1234567890';
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(SAMPLE_REGISTRATION);

    const result = await resolver.resolveAgent(1599, customRegistry);
    expect(result.name).toBe('TestAgent');
    expect(Contract).toHaveBeenCalledWith(customRegistry, expect.any(Array), expect.anything());
  });

  it('getPreferredTransport falls back to first service for non-standard types', async () => {
    const regWithENS: AgentRegistration = {
      ...SAMPLE_REGISTRATION,
      services: [
        { name: 'ENS', endpoint: 'agent.eth' },
      ],
    };
    setupTokenURI('https://agent.example.com/reg.json');
    mockFetchJSON(regWithENS);

    const preferred = await resolver.getPreferredTransport(1599);
    expect(preferred).not.toBeNull();
    expect(preferred!.transport).toBe('ENS');
    expect(preferred!.endpoint).toBe('agent.eth');
  });
});
