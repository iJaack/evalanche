import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvalancheMCPServer } from '../../src/mcp/server';

// Mock ethers at the module level
vi.mock('ethers', () => {
  const mockProvider = {
    getBalance: vi.fn().mockResolvedValue(BigInt('1000000000000000000')),
  };

  const mockWallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
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
    const result = res.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('evalanche');
  });

  it('lists tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(5);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain('get_address');
    expect(names).toContain('send_avax');
    expect(names).toContain('resolve_identity');
    expect(names).toContain('pay_and_fetch');
    expect(names).toContain('submit_feedback');
    expect(names).toContain('sign_message');
    expect(names).toContain('get_network');
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

  it('handles get_balance', async () => {
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

  it('handles get_network', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_network', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.network).toBe('avalanche');
  });

  it('returns error for unknown method', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'unknown/method',
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
  });

  it('returns error for unknown tool', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32602);
  });
});
