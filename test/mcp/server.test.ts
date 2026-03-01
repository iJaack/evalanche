import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalancheMCPServer } from '../../src/mcp/server';

// Mock ethers at the module level
vi.mock('ethers', () => {
  const mockProvider = {
    getBalance: vi.fn().mockResolvedValue(BigInt('1000000000000000000')),
  };

  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    privateKey: '0x' + 'a'.repeat(64),
    signMessage: vi.fn().mockResolvedValue('0xmocksignature'),
    sendTransaction: vi.fn().mockResolvedValue({
      hash: '0xmockhash',
      wait: vi.fn().mockResolvedValue({ hash: '0xmockhash', status: 1 }),
    }),
    connect: vi.fn(),
  };

  return {
    JsonRpcProvider: vi.fn().mockReturnValue(mockProvider),
    Wallet: vi.fn().mockReturnValue(mockWallet),
    HDNodeWallet: { fromPhrase: vi.fn().mockReturnValue({ ...mockWallet, connect: vi.fn().mockReturnValue(mockWallet) }) },
    Contract: vi.fn().mockReturnValue({}),
    parseEther: vi.fn((v: string) => BigInt(Math.floor(parseFloat(v) * 1e18))),
    parseUnits: vi.fn((v: string, d: number) => BigInt(Math.floor(parseFloat(v) * (10 ** d)))),
    formatEther: vi.fn((v: bigint) => (Number(v) / 1e18).toString()),
    solidityPackedKeccak256: vi.fn().mockReturnValue('0xmockhash'),
  };
});

describe('EvalancheMCPServer', () => {
  let server: EvalancheMCPServer;

  beforeEach(() => {
    server = new EvalancheMCPServer({
      privateKey: '0x' + 'a'.repeat(64),
      network: 'avalanche',
      identity: { agentId: '1599' },
    });
  });

  it('handles initialize', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(res.result).toBeDefined();
    const result = res.result as { protocolVersion: string; serverInfo: { name: string; version: string } };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('evalanche');
    expect(result.serverInfo.version).toBe('0.4.0');
  });

  it('lists tools including new bridge/chain tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(10);

    const names = result.tools.map((t) => t.name);
    // Original tools
    expect(names).toContain('get_address');
    expect(names).toContain('send_avax');
    expect(names).toContain('resolve_identity');
    expect(names).toContain('pay_and_fetch');
    expect(names).toContain('submit_feedback');
    expect(names).toContain('sign_message');
    expect(names).toContain('get_network');

    // New v0.4.0 tools
    expect(names).toContain('get_supported_chains');
    expect(names).toContain('get_chain_info');
    expect(names).toContain('get_bridge_quote');
    expect(names).toContain('get_bridge_routes');
    expect(names).toContain('bridge_tokens');
    expect(names).toContain('fund_destination_gas');
    expect(names).toContain('switch_network');
  });

  it('handles get_address', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_address', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.address).toMatch(/^0x/);
  });

  it('handles get_balance with correct currency symbol', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_balance', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.balance).toBeDefined();
    expect(parsed.unit).toBe('AVAX');
  });

  it('handles sign_message', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'sign_message', arguments: { message: 'test' } },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.signature).toBeDefined();
    expect(parsed.address).toBeDefined();
  });

  it('handles get_network with chain info', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_network', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.network).toBe('avalanche');
    expect(parsed.name).toBe('Avalanche C-Chain');
  });

  it('handles get_supported_chains', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_supported_chains', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(21);
    expect(parsed.chains).toBeInstanceOf(Array);
    expect(parsed.chains[0]).toHaveProperty('id');
    expect(parsed.chains[0]).toHaveProperty('name');
  });

  it('handles get_chain_info for current chain', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'get_chain_info', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('Avalanche C-Chain');
    expect(parsed.id).toBe(43114);
  });

  it('handles get_chain_info for specified chain', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_chain_info', arguments: { chainId: 8453 } },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('Base');
    expect(parsed.id).toBe(8453);
  });

  it('handles switch_network', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'switch_network', arguments: { network: 'base' } },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.network).toBe('base');
    expect(parsed.address).toMatch(/^0x/);
  });

  it('returns error for unknown method', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'unknown/method',
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
  });

  it('returns error for unknown tool', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
  });
});
