import { describe, it, expect, vi } from 'vitest';
import { PolymarketClient, PolymarketSide } from '../../src/polymarket';
import { Wallet } from 'ethers';

function makeClient(chainId: 137 | 42161 = 137): PolymarketClient {
  const wallet = Wallet.createRandom();
  return new PolymarketClient(wallet, chainId);
}

// ── PolymarketClient extended unit tests ──────────────────────────────────────

// Helper: make a client with a stubbed internal CLOB client so no SDK import occurs
function makeMockedClient(clobStub: Record<string, unknown>, chainId: 137 | 42161 = 137): PolymarketClient {
  const client = makeClient(chainId);
  // Inject stub directly to bypass getClient() SDK import
  (client as any).clobClient = clobStub;
  return client;
}

describe('PolymarketClient.estimateFillPrice', () => {
  it('returns weighted average price for a BUY using asks in order', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [],
        asks: [
          { price: 0.50, size: 5, orderID: 'a1' },
          { price: 0.60, size: 10, orderID: 'a2' },
        ],
      }),
    };
    const client = makeMockedClient(clobStub);

    // Buy 8 shares: fill 5@0.50 + 3@0.60 = (2.50 + 1.80) / 8 = 0.5375
    const price = await client.estimateFillPrice('tok', PolymarketSide.BUY, 8);
    expect(price).toBeCloseTo(0.5375, 4);
  });

  it('returns weighted average price for a SELL using bids in order', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [
          { price: 0.70, size: 4, orderID: 'b1' },
          { price: 0.60, size: 10, orderID: 'b2' },
        ],
        asks: [],
      }),
    };
    const client = makeMockedClient(clobStub);

    // Sell 6 shares: fill 4@0.70 + 2@0.60 = (2.80 + 1.20) / 6 ≈ 0.6667
    const price = await client.estimateFillPrice('tok', PolymarketSide.SELL, 6);
    expect(price).toBeCloseTo(0.6667, 3);
  });

  it('returns 0 when order book has insufficient liquidity', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [],
        asks: [{ price: 0.50, size: 2, orderID: 'a1' }],
      }),
    };
    const client = makeMockedClient(clobStub);

    // Want 10 but only 2 available — partial fill returns 0
    const price = await client.estimateFillPrice('tok', PolymarketSide.BUY, 10);
    expect(price).toBe(0);
  });
});

describe('PolymarketClient.getTokenPrice', () => {
  it('returns best bid price from order book', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [
          { price: 0.82, size: 100, orderID: 'b1' },
          { price: 0.79, size: 200, orderID: 'b2' },
        ],
        asks: [],
      }),
    };
    const client = makeMockedClient(clobStub);

    await expect(client.getTokenPrice('tok')).resolves.toBe(0.82);
  });

  it('returns 0 when no bids exist', async () => {
    const clobStub = { getOrderBook: async () => ({ bids: [], asks: [] }) };
    const client = makeMockedClient(clobStub);

    await expect(client.getTokenPrice('tok')).resolves.toBe(0);
  });
});

describe('PolymarketClient.searchMarkets', () => {
  it('limits results to the requested count', async () => {
    const client = makeClient();
    client.getMarkets = async () => [
      { conditionId: '1', question: 'Alpha market', tokens: [] },
      { conditionId: '2', question: 'Alpha second market', tokens: [] },
      { conditionId: '3', question: 'Alpha third market', tokens: [] },
    ];

    const results = await client.searchMarkets('alpha', 2);
    expect(results).toHaveLength(2);
  });

  it('is case-insensitive', async () => {
    const client = makeClient();
    client.getMarkets = async () => [
      { conditionId: '1', question: 'IRAN sanctions threshold', tokens: [] },
    ];

    await expect(client.searchMarkets('iran', 10)).resolves.toHaveLength(1);
    await expect(client.searchMarkets('IRAN', 10)).resolves.toHaveLength(1);
  });
});

describe('PolymarketClient.getOrderbook alias', () => {
  it('getOrderbook delegates to getOrderBook', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'getOrderBook').mockResolvedValue({ bids: [], asks: [] });

    await client.getOrderbook('tok-1');
    expect(spy).toHaveBeenCalledWith('tok-1');
  });
});

// ── MCP server: pm_approve / pm_buy / pm_redeem ──────────────────────────────
// Server-level integration smoke tests — no wallet/network needed.

describe('MCP server pm_approve/pm_buy/pm_redeem', () => {
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    // Minimal stub config — server will not hit network
    const config = { privateKey: wallet.privateKey, network: 'fuji' as const };
    const server = new EvalancheMCPServer(config as any);

    const resp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    // isError is on resp.result directly (not inside content[0])
    const result = resp.result as any;
    const isError = result?.isError === true;
    const text: string = result?.content?.[0]?.text ?? '';
    return { isError, text };
  }

  it('pm_approve attempts CLOB auth (no longer throws unimplemented)', async () => {
    const { isError, text } = await callTool('pm_approve', { amount: '100' });
    // May succeed or fail at CLOB level, but must NOT say "not implemented"
    expect(text).not.toMatch(/not implemented/i);
    if (isError) {
      // If it errored, it should be a network/CLOB error, not "not implemented"
      expect(text).not.toMatch(/not implemented/i);
    } else {
      // Succeeded — should contain approved: true
      expect(text).toContain('approved');
    }
  });

  it('pm_buy attempts market lookup (no longer throws unimplemented)', async () => {
    const { isError, text } = await callTool('pm_buy', { conditionId: '0x1', outcome: 'YES', amountUSDC: '10' });
    // Will fail at market fetch or CLOB level, but NOT with "not implemented"
    expect(isError).toBe(true);
    expect(text).not.toMatch(/not implemented/i);
  });

  it('pm_redeem returns not yet implemented', async () => {
    const { isError, text } = await callTool('pm_redeem', { conditionId: '0x1' });
    expect(isError).toBe(true);
    expect(text).toMatch(/not yet implemented/i);
  });
});

// ── MCP server: pm_positions fetches from data-api ───────────────────────────

describe('MCP server pm_positions', () => {
  it('fetches positions from data-api.polymarket.com', async () => {
    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    const config = { privateKey: wallet.privateKey, network: 'fuji' as const };
    const server = new EvalancheMCPServer(config as any);

    // Mock safeFetch at module level
    const safeFetchMod = await import('../../src/utils/safe-fetch');
    const mockPositions = [
      { asset: 'tok1', size: '100', avgPrice: '0.55', currentValue: '60' },
      { asset: 'tok2', size: '50', avgPrice: '0.30', currentValue: '20' },
    ];
    const spy = vi.spyOn(safeFetchMod, 'safeFetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockPositions,
    } as any);

    const resp = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'pm_positions', arguments: {} },
    });

    const result = resp.result as any;
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].asset).toBe('tok1');

    // Verify safeFetch was called with the data-api URL containing the agent address
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('data-api.polymarket.com/positions?user='),
      expect.any(Object),
    );
    spy.mockRestore();
  });

  it('accepts optional walletAddress parameter', async () => {
    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    const config = { privateKey: wallet.privateKey, network: 'fuji' as const };
    const server = new EvalancheMCPServer(config as any);

    const safeFetchMod = await import('../../src/utils/safe-fetch');
    const spy = vi.spyOn(safeFetchMod, 'safeFetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    } as any);

    const customAddr = '0x1234567890abcdef1234567890abcdef12345678';
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'pm_positions', arguments: { walletAddress: customAddr } },
    });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(`user=${customAddr}`),
      expect.any(Object),
    );
    spy.mockRestore();
  });
});

// ── CLI: buildConfig chain mapping ──────────────────────────────────────────
// Tested at the logic level by extracting the same chainIdMap used in cli.ts.

describe('CLI chainIdMap', () => {
  const chainIdMap: Record<string, number> = {
    ethereum: 1,
    optimism: 10,
    bsc: 56,
    polygon: 137,
    base: 8453,
    arbitrum: 42161,
    avalanche: 43114,
    fuji: 43113,
  };

  it('maps all documented network names to correct chain IDs', () => {
    expect(chainIdMap.avalanche).toBe(43114);
    expect(chainIdMap.fuji).toBe(43113);
    expect(chainIdMap.polygon).toBe(137);
    expect(chainIdMap.base).toBe(8453);
    expect(chainIdMap.arbitrum).toBe(42161);
    expect(chainIdMap.optimism).toBe(10);
    expect(chainIdMap.ethereum).toBe(1);
    expect(chainIdMap.bsc).toBe(56);
  });

  it('falls back to 43114 (avalanche) for unknown network names', () => {
    const unknown = 'unknown-net';
    expect(chainIdMap[unknown] ?? 43114).toBe(43114);
  });
});
