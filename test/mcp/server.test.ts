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
    expect(result.serverInfo.version).toBe('0.9.0');
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
    expect(names).toContain('approve_and_call');
    expect(names).toContain('upgrade_proxy');

    // New v0.6.0 platform-cli tools
    expect(names).toContain('platform_cli_available');
    expect(names).toContain('subnet_create');
    expect(names).toContain('subnet_convert_l1');
    expect(names).toContain('subnet_transfer_ownership');
    expect(names).toContain('add_validator');
    expect(names).toContain('l1_register_validator');
    expect(names).toContain('l1_add_balance');
    expect(names).toContain('l1_disable_validator');
    expect(names).toContain('node_info');
    expect(names).toContain('pchain_send');

    // New v0.7.0 dYdX perps tools
    expect(names).toContain('dydx_get_markets');
    expect(names).toContain('dydx_has_market');
    expect(names).toContain('dydx_get_balance');
    expect(names).toContain('dydx_get_positions');
    expect(names).toContain('dydx_place_market_order');
    expect(names).toContain('dydx_place_limit_order');
    expect(names).toContain('dydx_cancel_order');
    expect(names).toContain('dydx_close_position');
    expect(names).toContain('dydx_get_orders');
    expect(names).toContain('find_perp_market');
  });

  it('handles dydx_get_markets', async () => {
    const mockDydx = {
      getMarkets: vi.fn().mockResolvedValue([{ ticker: 'ETH-USD', oraclePrice: '3000' }]),
    };
    const agent = (server as unknown as { agent: { dydx: ReturnType<typeof vi.fn> } }).agent;
    agent.dydx = vi.fn().mockResolvedValue(mockDydx);

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'dydx_get_markets', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.markets[0].ticker).toBe('ETH-USD');
  });

  it('handles dydx_place_market_order', async () => {
    const mockDydx = {
      placeMarketOrder: vi.fn().mockResolvedValue('ETH-USD:123:32'),
    };
    const agent = (server as unknown as { agent: { dydx: ReturnType<typeof vi.fn> } }).agent;
    agent.dydx = vi.fn().mockResolvedValue(mockDydx);

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'dydx_place_market_order',
        arguments: { market: 'ETH-USD', side: 'BUY', size: '0.1' },
      },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.orderId).toBe('ETH-USD:123:32');
  });

  it('handles find_perp_market', async () => {
    const agent = (server as unknown as { agent: { findPerpMarket: ReturnType<typeof vi.fn> } }).agent;
    agent.findPerpMarket = vi.fn().mockResolvedValue({
      venue: 'dydx',
      market: { ticker: 'ETH-USD' },
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'find_perp_market', arguments: { ticker: 'ETH-USD' } },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.venue).toBe('dydx');
    expect(parsed.market.ticker).toBe('ETH-USD');
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

  // Economy tools (v1.0.0)
  it('lists economy tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/list',
    });
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('get_budget');
    expect(names).toContain('set_policy');
    expect(names).toContain('simulate_tx');
  });

  it('handles get_budget with no policy', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'get_budget', arguments: {} },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message).toBe('No spending policy set');
  });

  it('handles set_policy and get_budget', async () => {
    // Set a policy
    const setRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: {
        name: 'set_policy',
        arguments: {
          maxPerTransaction: '100000000000000000',
          maxPerDay: '1000000000000000000',
          allowlistedChains: [43114, 8453],
        },
      },
    });
    const setResult = setRes.result as { content: Array<{ text: string }> };
    const setParsed = JSON.parse(setResult.content[0].text);
    expect(setParsed.success).toBe(true);
    expect(setParsed.policy.maxPerTransaction).toBe('100000000000000000');
    expect(setParsed.policy.allowlistedChains).toEqual([43114, 8453]);

    // Now get_budget should show the policy
    const budgetRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: { name: 'get_budget', arguments: {} },
    });
    const budgetResult = budgetRes.result as { content: Array<{ text: string }> };
    const budgetParsed = JSON.parse(budgetResult.content[0].text);
    expect(budgetParsed.policy).toBeDefined();
    expect(budgetParsed.spentLastHour).toBe('0');
    expect(budgetParsed.remainingDaily).toBe('1000000000000000000');
  });

  it('handles set_policy removal', async () => {
    // Set then remove
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'set_policy', arguments: { maxPerDay: '1000' } },
    });
    const removeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: { name: 'set_policy', arguments: {} },
    });
    const removeParsed = JSON.parse(
      (removeRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(removeParsed.message).toBe('Policy removed');
  });

  it('handles simulate_tx', async () => {
    // Mock provider.call and provider.estimateGas for simulation
    const agent = (server as unknown as { agent: { simulateTransaction: ReturnType<typeof vi.fn> } }).agent;
    agent.simulateTransaction = vi.fn().mockResolvedValue({
      success: true,
      gasEstimate: '21000',
      returnData: '0x',
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: {
        name: 'simulate_tx',
        arguments: { to: '0x1234567890abcdef1234567890abcdef12345678', value: '0.1' },
      },
    });
    const result = res.result as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.gasEstimate).toBe('21000');
  });

  // Discovery tools (v1.0.0)
  it('handles register_service and discover_agents', async () => {
    // Register a service
    const regRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: {
        name: 'register_service',
        arguments: {
          capability: 'code-audit',
          description: 'Smart contract audit',
          endpoint: 'https://example.com/audit',
          pricePerCall: '10000000000000000',
          chainId: 43114,
          tags: ['solidity'],
        },
      },
    });
    const regParsed = JSON.parse(
      (regRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(regParsed.success).toBe(true);
    expect(regParsed.agentId).toBe('1599'); // from identity config

    // Discover it
    const discoverRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: {
        name: 'discover_agents',
        arguments: { capability: 'audit' },
      },
    });
    const discoverParsed = JSON.parse(
      (discoverRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(discoverParsed.count).toBe(1);
    expect(discoverParsed.services[0].capability).toBe('code-audit');
  });

  it('handles resolve_agent_profile', async () => {
    // Register first so profile has services
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: {
        name: 'register_service',
        arguments: {
          capability: 'analysis',
          description: 'Token analysis',
          endpoint: 'https://example.com/analysis',
          pricePerCall: '5000000000000000',
          chainId: 8453,
        },
      },
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: { name: 'resolve_agent_profile', arguments: { agentId: '1599' } },
    });
    const parsed = JSON.parse(
      (res.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(parsed.agentId).toBe('1599');
    expect(parsed.services.length).toBeGreaterThanOrEqual(1);
  });

  it('handles discover_agents with no results', async () => {
    // Fresh server — create new one to avoid leftover registrations
    const freshServer = new EvalancheMCPServer({
      privateKey: '0x' + 'a'.repeat(64),
      network: 'avalanche',
    });
    const res = await freshServer.handleRequest({
      jsonrpc: '2.0',
      id: 44,
      method: 'tools/call',
      params: { name: 'discover_agents', arguments: { capability: 'nonexistent' } },
    });
    const parsed = JSON.parse(
      (res.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(parsed.count).toBe(0);
    expect(parsed.services).toEqual([]);
  });

  // Service host tools (v1.0.0)
  it('handles serve_endpoint and list_services', async () => {
    const serveRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 50,
      method: 'tools/call',
      params: {
        name: 'serve_endpoint',
        arguments: {
          path: '/audit',
          price: '0.01',
          currency: 'ETH',
          chainId: 8453,
          responseTemplate: '{"result":"done"}',
        },
      },
    });
    const serveParsed = JSON.parse(
      (serveRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(serveParsed.success).toBe(true);
    expect(serveParsed.path).toBe('/audit');

    // List services
    const listRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/call',
      params: { name: 'list_services', arguments: {} },
    });
    const listParsed = JSON.parse(
      (listRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(listParsed.count).toBe(1);
    expect(listParsed.endpoints[0].path).toBe('/audit');
  });

  it('handles get_revenue', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'tools/call',
      params: { name: 'get_revenue', arguments: {} },
    });
    const parsed = JSON.parse(
      (res.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(parsed.totalRequests).toBeDefined();
    expect(typeof parsed.totalRequests).toBe('number');
  });

  it('lists all economy and service tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 53,
      method: 'tools/list',
    });
    const result = res.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('serve_endpoint');
    expect(names).toContain('get_revenue');
    expect(names).toContain('list_services');
    expect(names).toContain('negotiate_task');
    expect(names).toContain('settle_payment');
    expect(names).toContain('get_agreements');
  });

  it('handles negotiate_task propose and accept flow', async () => {
    // Propose
    const proposeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: {
          action: 'propose',
          fromAgentId: 'agentA',
          toAgentId: 'agentB',
          task: 'smart-contract-audit',
          price: '500000000000000000',
          chainId: 8453,
        },
      },
    });
    const proposed = JSON.parse(
      (proposeRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(proposed.proposalId).toMatch(/^prop_/);
    expect(proposed.status).toBe('pending');

    // Accept
    const acceptRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'accept', proposalId: proposed.proposalId },
      },
    });
    const accepted = JSON.parse(
      (acceptRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(accepted.status).toBe('accepted');
    expect(accepted.agreedPrice).toBe('500000000000000000');
  });

  it('handles negotiate_task counter flow', async () => {
    const proposeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: {
          action: 'propose',
          fromAgentId: 'agentA',
          toAgentId: 'agentB',
          task: 'audit',
          price: '100',
          chainId: 1,
        },
      },
    });
    const proposed = JSON.parse(
      (proposeRes.result as { content: Array<{ text: string }> }).content[0].text,
    );

    const counterRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 63,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'counter', proposalId: proposed.proposalId, counterPrice: '200' },
      },
    });
    const countered = JSON.parse(
      (counterRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(countered.status).toBe('countered');
    expect(countered.counterPrice).toBe('200');
  });

  it('handles negotiate_task reject', async () => {
    const proposeRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 64,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: {
          action: 'propose',
          fromAgentId: 'X',
          toAgentId: 'Y',
          task: 'test',
          price: '1',
          chainId: 1,
        },
      },
    });
    const proposed = JSON.parse(
      (proposeRes.result as { content: Array<{ text: string }> }).content[0].text,
    );

    const rejectRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 65,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'reject', proposalId: proposed.proposalId },
      },
    });
    const rejected = JSON.parse(
      (rejectRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(rejected.status).toBe('rejected');
  });

  it('handles get_agreements with filters', async () => {
    // Create two proposals
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 66,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'propose', fromAgentId: 'A', toAgentId: 'B', task: 'x', price: '1', chainId: 1 },
      },
    });
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 67,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'propose', fromAgentId: 'C', toAgentId: 'D', task: 'y', price: '2', chainId: 1 },
      },
    });

    // List all
    const allRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 68,
      method: 'tools/call',
      params: { name: 'get_agreements', arguments: {} },
    });
    const all = JSON.parse(
      (allRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(all.count).toBeGreaterThanOrEqual(2);

    // Filter by agent
    const filteredRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 69,
      method: 'tools/call',
      params: { name: 'get_agreements', arguments: { agentId: 'A' } },
    });
    const filtered = JSON.parse(
      (filteredRes.result as { content: Array<{ text: string }> }).content[0].text,
    );
    expect(filtered.count).toBe(1);
  });

  it('handles negotiate_task with invalid action', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: {
        name: 'negotiate_task',
        arguments: { action: 'invalid_action' },
      },
    });
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown negotiate action');
  });

  // ── Phase 5: Memory MCP tools ──

  it('handles record_interaction and get_transaction_history', async () => {
    // Record two interactions
    await server.handleRequest({
      jsonrpc: '2.0', id: 80, method: 'tools/call',
      params: { name: 'record_interaction', arguments: { type: 'payment_sent', counterpartyId: 'agent-42', amount: '1000', chainId: 8453 } },
    });
    await server.handleRequest({
      jsonrpc: '2.0', id: 81, method: 'tools/call',
      params: { name: 'record_interaction', arguments: { type: 'service_called', counterpartyId: 'agent-42', metadata: { capability: 'audit' } } },
    });

    // Query all
    const histRes = await server.handleRequest({
      jsonrpc: '2.0', id: 82, method: 'tools/call',
      params: { name: 'get_transaction_history', arguments: {} },
    });
    const hist = JSON.parse((histRes.result as { content: Array<{ text: string }> }).content[0].text);
    expect(hist.count).toBeGreaterThanOrEqual(2);

    // Query by counterparty
    const filtRes = await server.handleRequest({
      jsonrpc: '2.0', id: 83, method: 'tools/call',
      params: { name: 'get_transaction_history', arguments: { counterpartyId: 'agent-42' } },
    });
    const filt = JSON.parse((filtRes.result as { content: Array<{ text: string }> }).content[0].text);
    expect(filt.count).toBe(2);
  });

  it('handles get_relationships for a specific agent', async () => {
    // Record interaction first
    await server.handleRequest({
      jsonrpc: '2.0', id: 84, method: 'tools/call',
      params: { name: 'record_interaction', arguments: { type: 'payment_sent', counterpartyId: 'agent-99', amount: '500', reputationScore: 85 } },
    });

    const relRes = await server.handleRequest({
      jsonrpc: '2.0', id: 85, method: 'tools/call',
      params: { name: 'get_relationships', arguments: { agentId: 'agent-99' } },
    });
    const rel = JSON.parse((relRes.result as { content: Array<{ text: string }> }).content[0].text);
    expect(rel.agentId).toBe('agent-99');
    expect(rel.totalInteractions).toBe(1);
    expect(rel.trustScore).toBeGreaterThanOrEqual(0);
  });

  it('handles get_relationships for all agents', async () => {
    const allRes = await server.handleRequest({
      jsonrpc: '2.0', id: 86, method: 'tools/call',
      params: { name: 'get_relationships', arguments: {} },
    });
    const all = JSON.parse((allRes.result as { content: Array<{ text: string }> }).content[0].text);
    expect(all.relationships).toBeDefined();
    expect(typeof all.count).toBe('number');
  });

  it('handles get_relationships by capability', async () => {
    // Record interaction with capability metadata
    await server.handleRequest({
      jsonrpc: '2.0', id: 87, method: 'tools/call',
      params: { name: 'record_interaction', arguments: { type: 'service_called', counterpartyId: 'audit-agent', metadata: { capability: 'code-audit' } } },
    });

    const capRes = await server.handleRequest({
      jsonrpc: '2.0', id: 88, method: 'tools/call',
      params: { name: 'get_relationships', arguments: { capability: 'audit' } },
    });
    const cap = JSON.parse((capRes.result as { content: Array<{ text: string }> }).content[0].text);
    expect(cap.preferredAgents).toBeDefined();
    expect(cap.count).toBeGreaterThanOrEqual(1);
  });

  it('lists all Phase 5 memory tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 89, method: 'tools/list',
    });
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('record_interaction');
    expect(names).toContain('get_transaction_history');
    expect(names).toContain('get_relationships');
  });

  // ── Phase 7: Interop — ERC-8004 Identity Resolution MCP tools ──

  it('lists all Phase 7 interop tools', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 100, method: 'tools/list',
    });
    const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('resolve_agent_registration');
    expect(names).toContain('get_agent_services');
    expect(names).toContain('get_agent_wallet');
    expect(names).toContain('verify_agent_endpoint');
    expect(names).toContain('resolve_by_wallet');
  });

  it('handles resolve_agent_registration', async () => {
    const interopResolver = (server as unknown as { interopResolver: { resolveAgent: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.resolveAgent = vi.fn().mockResolvedValue({
      name: 'TestAgent',
      agentWallet: '0xWallet',
      services: [{ name: 'A2A', endpoint: 'https://example.com/a2a' }],
      active: true,
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 101, method: 'tools/call',
      params: { name: 'resolve_agent_registration', arguments: { agentId: '1599' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.name).toBe('TestAgent');
    expect(parsed.services).toHaveLength(1);
  });

  it('handles get_agent_services', async () => {
    const interopResolver = (server as unknown as { interopResolver: { getServiceEndpoints: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.getServiceEndpoints = vi.fn().mockResolvedValue([
      { name: 'A2A', endpoint: 'https://example.com/a2a' },
      { name: 'web', endpoint: 'https://example.com' },
    ]);

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 102, method: 'tools/call',
      params: { name: 'get_agent_services', arguments: { agentId: '1599' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.services[0].name).toBe('A2A');
  });

  it('handles get_agent_wallet', async () => {
    const interopResolver = (server as unknown as { interopResolver: { resolveAgentWallet: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.resolveAgentWallet = vi.fn().mockResolvedValue('0xPaymentWallet');

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 103, method: 'tools/call',
      params: { name: 'get_agent_wallet', arguments: { agentId: '1599' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.wallet).toBe('0xPaymentWallet');
    expect(parsed.agentId).toBe('1599');
  });

  it('handles verify_agent_endpoint', async () => {
    const interopResolver = (server as unknown as { interopResolver: { verifyEndpointBinding: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.verifyEndpointBinding = vi.fn().mockResolvedValue({ verified: true });

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 104, method: 'tools/call',
      params: { name: 'verify_agent_endpoint', arguments: { agentId: '1599', endpoint: 'https://example.com/api' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.verified).toBe(true);
    expect(parsed.agentId).toBe('1599');
  });

  it('handles resolve_by_wallet with result', async () => {
    const interopResolver = (server as unknown as { interopResolver: { resolveByWallet: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.resolveByWallet = vi.fn().mockResolvedValue('42');

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 105, method: 'tools/call',
      params: { name: 'resolve_by_wallet', arguments: { address: '0xSomeWallet' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.agentId).toBe('42');
    expect(parsed.address).toBe('0xSomeWallet');
  });

  it('handles resolve_by_wallet with no result', async () => {
    const interopResolver = (server as unknown as { interopResolver: { resolveByWallet: ReturnType<typeof vi.fn> } }).interopResolver;
    interopResolver.resolveByWallet = vi.fn().mockResolvedValue(null);

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 106, method: 'tools/call',
      params: { name: 'resolve_by_wallet', arguments: { address: '0xUnknown' } },
    });
    const parsed = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.agentId).toBeNull();
    expect(parsed.message).toContain('No agent found');
  });
});
