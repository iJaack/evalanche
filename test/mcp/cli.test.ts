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
});
