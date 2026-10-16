import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cliState = vi.hoisted(() => ({
  configs: [] as unknown[],
  startStdio: vi.fn(),
  resolveAgentSecrets: vi.fn(),
}));

vi.mock('../../src/mcp/server', () => ({
  EvalancheMCPServer: class {
    constructor(config: unknown) {
      cliState.configs.push(config);
    }

    startStdio(): void {
      cliState.startStdio();
    }

    startHTTP(): void {
      throw new Error('Unexpected HTTP startup');
    }
  },
}));

vi.mock('../../src/secrets', () => ({
  resolveAgentSecrets: cliState.resolveAgentSecrets,
}));

describe('Evalanche MCP CLI configuration', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    cliState.configs.length = 0;
    cliState.startStdio.mockClear();
    cliState.resolveAgentSecrets.mockReset();
    cliState.resolveAgentSecrets.mockResolvedValue({
      privateKey: '0xabc',
      source: 'env',
    });
    process.argv = ['node', 'evalanche-mcp'];
    vi.stubEnv('AGENT_ID', '');
    vi.stubEnv('AGENT_REGISTRY', '');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });

  it('preserves the Robinhood network when applying a custom RPC override', async () => {
    vi.stubEnv('AVALANCHE_NETWORK', 'robinhood');
    vi.stubEnv('AVALANCHE_RPC_URL', 'https://rpc.example');

    await import('../../src/mcp/cli');

    await vi.waitFor(() => expect(cliState.configs).toHaveLength(1));
    expect(cliState.configs[0]).toEqual({
      privateKey: '0xabc',
      network: 'robinhood',
      rpcOverride: 'https://rpc.example',
    });
    expect(cliState.startStdio).toHaveBeenCalledOnce();
  });

  it('starts keyless when --signer-url and --signer-address are set', async () => {
    cliState.resolveAgentSecrets.mockResolvedValue({ source: 'keystore' });
    process.argv = ['node', 'evalanche-mcp', '--signer-url', 'http://127.0.0.1:7410', '--signer-address', '0x0000000000000000000000000000000000000001'];
    vi.stubEnv('AGENT_PRIVATE_KEY', '');
    vi.stubEnv('AGENT_MNEMONIC', '');

    await import('../../src/mcp/cli');

    await vi.waitFor(() => expect(cliState.configs).toHaveLength(1));
    expect(cliState.configs[0]).toMatchObject({
      signer: {
        url: 'http://127.0.0.1:7410',
        address: '0x0000000000000000000000000000000000000001',
        tokenEnv: 'EVALANCHE_SIGNER_TOKEN',
      },
      network: 'avalanche',
    });
    expect(cliState.configs[0]).not.toHaveProperty('privateKey');
    expect(cliState.resolveAgentSecrets).not.toHaveBeenCalled();
  });

  it('skips resolveAgentSecrets in address-only mode so a local key cannot win', async () => {
    cliState.resolveAgentSecrets.mockResolvedValue({ privateKey: '0xabc', source: 'env' });
    vi.stubEnv('EVALANCHE_ADDRESS', '0x0000000000000000000000000000000000000001');
    vi.stubEnv('AGENT_PRIVATE_KEY', '');
    vi.stubEnv('AGENT_MNEMONIC', '');

    await import('../../src/mcp/cli');

    await vi.waitFor(() => expect(cliState.configs).toHaveLength(1));
    expect(cliState.resolveAgentSecrets).not.toHaveBeenCalled();
    expect(cliState.configs[0]).toMatchObject({
      address: '0x0000000000000000000000000000000000000001',
      network: 'avalanche',
    });
    expect(cliState.configs[0]).not.toHaveProperty('privateKey');
    expect(cliState.configs[0]).not.toHaveProperty('mnemonic');
  });
});
