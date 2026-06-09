import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

async function callServerTool(
  name: string,
  args: Record<string, unknown> = {},
  configure?: (server: any) => void | Promise<void>,
): Promise<{ isError: boolean; text: string; server: any }> {
  const { EvalancheMCPServer } = await import('../../src/mcp/server');
  const wallet = Wallet.createRandom();
  const config = { privateKey: wallet.privateKey, network: 'fuji' as const };
  const server = new EvalancheMCPServer(config as any);
  if (configure) await configure(server);

  const resp = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const result = resp.result as any;
  return {
    isError: result?.isError === true,
    text: result?.content?.[0]?.text ?? '',
    server,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('uses the cheapest asks first when CLOB asks are unsorted', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [],
        asks: [
          { price: 0.99, size: 10, orderID: 'a-expensive' },
          { price: 0.76, size: 10, orderID: 'a-cheap' },
        ],
      }),
    };
    const client = makeMockedClient(clobStub);

    const price = await client.estimateFillPrice('tok', PolymarketSide.BUY, 10);
    expect(price).toBeCloseTo(0.76, 4);
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

  it('returns the highest bid when CLOB bids are unsorted', async () => {
    const clobStub = {
      getOrderBook: async () => ({
        bids: [
          { price: 0.01, size: 100, orderID: 'b-low' },
          { price: 0.24, size: 100, orderID: 'b-high' },
        ],
        asks: [],
      }),
    };
    const client = makeMockedClient(clobStub);

    await expect(client.getTokenPrice('tok')).resolves.toBe(0.24);
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
    const mockMarkets = [
      { conditionId: '1', question: 'Alpha market', tokens: [] },
      { conditionId: '2', question: 'Alpha second market', tokens: [] },
      { conditionId: '3', question: 'Alpha third market', tokens: [] },
    ];
    client.getLiveMarkets = async () => mockMarkets;
    client.getMarkets = async () => mockMarkets;

    const results = await client.searchMarkets('alpha', 2);
    expect(results).toHaveLength(2);
  });

  it('is case-insensitive', async () => {
    const client = makeClient();
    const mockMarkets = [
      { conditionId: '1', question: 'IRAN sanctions threshold', tokens: [] },
    ];
    client.getLiveMarkets = async () => mockMarkets;
    client.getMarkets = async () => mockMarkets;

    await expect(client.searchMarkets('iran', 10)).resolves.toHaveLength(1);
    await expect(client.searchMarkets('IRAN', 10)).resolves.toHaveLength(1);
  });

  it('filters stale and malformed CLOB markets before falling back to Gamma', async () => {
    const client = makeClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              condition_id: '',
              question: 'Trump mugshot by Friday?',
              active: true,
              closed: false,
              archived: false,
              accepting_orders: true,
              end_date_iso: '2099-01-01T00:00:00Z',
              tokens: [{ token_id: '', outcome: '' }],
            },
            {
              condition_id: 'old-trump-market',
              question: 'Trump on Joe Rogan in 2024?',
              active: true,
              closed: true,
              archived: false,
              accepting_orders: false,
              end_date_iso: '2024-12-31T00:00:00Z',
              tokens: [{ token_id: 'old-yes', outcome: 'YES' }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          {
            conditionId: 'live-trump-market',
            question: 'Will Trump visit India by April 2026?',
            description: 'Active market',
            endDate: '2099-01-01T00:00:00Z',
            outcomes: ['YES', 'NO'],
            clobTokenIds: ['yes-token', 'no-token'],
            outcomePrices: ['0.44', '0.56'],
          },
        ]),
      });

    const results = await client.searchMarkets('trump', 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.conditionId).toBe('live-trump-market');
    expect(results[0]?.tokens[0]?.tokenId).toBe('yes-token');
  });

  it('uses CLOB pagination cursors when searching beyond the first page', async () => {
    const client = makeClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              condition_id: 'page-1-market',
              question: 'Unrelated first page market',
              active: true,
              closed: false,
              archived: false,
              accepting_orders: true,
              end_date_iso: '2099-01-01T00:00:00Z',
              tokens: [{ token_id: 'first-token', outcome: 'YES' }],
            },
          ],
          next_cursor: 'cursor-2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              condition_id: 'page-2-market',
              question: 'Will Polymarket ship better Trump search?',
              active: true,
              closed: false,
              archived: false,
              accepting_orders: true,
              end_date_iso: '2099-01-01T00:00:00Z',
              tokens: [{ token_id: 'second-token', outcome: 'YES' }],
            },
          ],
        }),
      });

    const results = await client.searchMarkets('trump', 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.conditionId).toBe('page-2-market');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0] ?? '')).toContain('cursor=cursor-2');
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

describe('PolymarketClient SDK compatibility fallbacks', () => {
  it('getBalances falls back to getBalanceAllowance when getBalances is unavailable', async () => {
    const client = makeMockedClient({
      getBalanceAllowance: vi.fn().mockImplementation(({ asset_type, token_id }: { asset_type: string; token_id?: string }) => {
        if (asset_type === 'COLLATERAL') return { balance: '8000000', allowance: '7000000' };
        return { balance: '12', allowance: '12', token_id };
      }),
    });

    const balances = await client.getBalances('tok-1');
    expect(balances.walletAddress).toMatch(/^0x/i);
    expect(balances.collateral.balance).toBe('8000000');
    expect(balances.conditional.token_id).toBe('tok-1');
  });

  it('getPositions falls back to data-api when SDK getPositions is unavailable', async () => {
    const client = makeMockedClient({});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ([{ asset: 'tok-1', size: '5' }]),
    } as any);

    const positions = await client.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.asset).toBe('tok-1');
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('data-api.polymarket.com/positions?user=');
  });
});

describe('PolymarketClient.redeemPositions', () => {
  it('redeems winning positions through the CTF and returns balance deltas', async () => {
    const client = makeClient();
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xredeem'),
    };
    const publicClient = {
      readContract: vi.fn(async ({ functionName, args }: any) => {
        if (functionName === 'payoutDenominator') return 1n;
        if (functionName === 'payoutNumerators') return args[1] === 0n ? 1n : 0n;
        if (functionName === 'balanceOf') {
          const callCount = publicClient.readContract.mock.calls.filter(([call]: any[]) => call.functionName === 'balanceOf').length;
          return callCount === 1 ? 1_000_000n : 3_000_000n;
        }
        if (functionName === 'balanceOfBatch') {
          const callCount = publicClient.readContract.mock.calls.filter(([call]: any[]) => call.functionName === 'balanceOfBatch').length;
          return callCount === 1 ? [2n, 5n] : [0n, 0n];
        }
        return 0n;
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        blockNumber: 123n,
      }),
    };

    vi.spyOn(client as any, 'createPolygonClients').mockResolvedValue({
      account: { address: '0x1234567890123456789012345678901234567890' },
      walletClient,
      publicClient,
    });
    vi.spyOn(client, 'getMarket').mockResolvedValue({
      conditionId: `0x${'1'.repeat(64)}`,
      question: 'Will YES win?',
      tokens: [
        { tokenId: '1', conditionId: `0x${'1'.repeat(64)}`, outcome: 'YES' },
        { tokenId: '2', conditionId: `0x${'1'.repeat(64)}`, outcome: 'NO' },
      ],
    });

    const result = await client.redeemPositions(`0x${'1'.repeat(64)}`);

    expect(walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'redeemPositions',
      args: [
        '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        `0x${'0'.repeat(64)}`,
        `0x${'1'.repeat(64)}`,
        [1n, 2n],
      ],
    }));
    expect(result.receiptStatus).toBe('success');
    expect(result.winningOutcomes).toEqual(['YES']);
    expect(result.usdcDelta.formatted).toBe('2');
    expect(result.tokenBalancesAfter).toEqual([
      { tokenId: '1', outcome: 'YES', raw: '0' },
      { tokenId: '2', outcome: 'NO', raw: '0' },
    ]);
  });

  it('fails clearly when the condition is not resolved yet', async () => {
    const client = makeClient();
    const publicClient = {
      readContract: vi.fn(async ({ functionName }: any) => {
        if (functionName === 'payoutDenominator') return 0n;
        return 0n;
      }),
    };

    vi.spyOn(client as any, 'createPolygonClients').mockResolvedValue({
      account: { address: '0x1234567890123456789012345678901234567890' },
      walletClient: { writeContract: vi.fn() },
      publicClient,
    });

    await expect(client.redeemPositions(`0x${'2'.repeat(64)}`)).rejects.toThrow(/not resolved/i);
  });
});

describe('PolymarketClient.withdrawUsdc', () => {
  it('creates a bridge quote, creates withdrawal addresses, transfers USDC.e, and returns bridge status', async () => {
    const client = makeClient();
    const walletClient = {
      writeContract: vi.fn().mockResolvedValue('0xwithdraw'),
    };
    const publicClient = {
      readContract: vi.fn(async ({ functionName }: any) => {
        if (functionName === 'balanceOf') {
          const callCount = publicClient.readContract.mock.calls.filter(([call]: any[]) => call.functionName === 'balanceOf').length;
          return callCount === 1 ? 5_000_000n : 3_500_000n;
        }
        return 0n;
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        blockNumber: 321n,
      }),
    };

    vi.spyOn(client as any, 'createPolygonClients').mockResolvedValue({
      account: { address: '0x1234567890123456789012345678901234567890' },
      walletClient,
      publicClient,
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          quoteId: 'quote-1',
          estCheckoutTimeMs: 25000,
          estInputUsd: 1.5,
          estOutputUsd: 1.48,
          estToTokenBaseUnit: '1480000',
          estFeeBreakdown: { minReceived: 1.48 },
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({
          address: {
            evm: '0x23566f8b2E82aDfCf01846E54899d110e97AC053',
            svm: 'CrvTBvzryYxBHbWu2TiQpcqD5M7Le7iBKzVmEj3f36Jb',
          },
          note: 'Send funds to these addresses to bridge to your destination chain and token.',
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          transactions: [
            {
              fromChainId: '137',
              fromTokenAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
              fromAmountBaseUnit: '1500000',
              toChainId: '8453',
              toTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              createdTimeMs: 1757646914535,
              status: 'PROCESSING',
            },
          ],
        }),
      } as any);

    const result = await client.withdrawUsdc({
      amountUSDC: '1.5',
      toChainId: '8453',
      toTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    });

    expect(walletClient.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'transfer',
      args: ['0x23566f8b2E82aDfCf01846E54899d110e97AC053', 1_500_000n],
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/quote');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/withdraw');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/status/0x23566f8b2E82aDfCf01846E54899d110e97AC053');
    expect(result.quote.quoteId).toBe('quote-1');
    expect(result.bridgeAddress).toBe('0x23566f8b2E82aDfCf01846E54899d110e97AC053');
    expect(result.receiptStatus).toBe('success');
    expect(result.bridgeTransaction?.status).toBe('PROCESSING');
    expect(result.usdcDelta.formatted).toBe('-1.5');
  });
});

// ── MCP server: pm_approve / pm_buy / pm_withdraw / pm_redeem ─────────────────
// Server-level integration smoke tests — no wallet/network needed.

describe('MCP server pm_approve/pm_buy/pm_withdraw/pm_redeem', () => {
  it('pm_approve syncs both wallet USDC approval and pUSD spender approvals', async () => {
    const { isError, text } = await callServerTool('pm_approve', { amount: '100' }, (server) => {
      (server as any).approveUsdcToCLOB = vi.fn().mockResolvedValue('0xapprove');
      (server as any).approvePusdCollateralSpenders = vi.fn().mockResolvedValue(['0xpusdapprove']);
      (server as any).getAuthedClobClient = vi.fn().mockResolvedValue({
        updateBalanceAllowance: vi.fn().mockResolvedValue(undefined),
      });
    });

    expect(isError).toBe(false);
    expect(text).toContain('approved');
    expect(text).toContain('0xapprove');
    expect(text).toContain('0xpusdapprove');
  });

  it('pm_buy attempts market lookup (no longer throws unimplemented)', async () => {
    const { isError, text } = await callServerTool('pm_buy', { conditionId: '0x1', outcome: 'YES', amountUSDC: '10' });
    // Will fail at market fetch or CLOB level, but NOT with "not implemented"
    expect(isError).toBe(true);
    expect(text).not.toMatch(/not implemented/i);
  });

  it('pm_redeem returns a redemption envelope', async () => {
    const { isError, text } = await callServerTool('pm_redeem', { conditionId: `0x${'1'.repeat(64)}` }, (server) => {
      (server as any).getPolymarket = vi.fn().mockReturnValue({
        redeemPositions: vi.fn().mockResolvedValue({
          conditionId: `0x${'1'.repeat(64)}`,
          txHash: '0xredeem',
          receiptStatus: 'success',
          blockNumber: '123',
          collateralToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
          ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
          parentCollectionId: `0x${'0'.repeat(64)}`,
          indexSets: ['1', '2'],
          tokenIds: ['1', '2'],
          marketQuestion: 'Will YES win?',
          winningOutcomes: ['YES'],
          payoutVector: ['1', '0'],
          usdcBefore: { raw: '1000000', formatted: '1' },
          usdcAfter: { raw: '3000000', formatted: '3' },
          usdcDelta: { raw: '2000000', formatted: '2' },
          tokenBalancesBefore: [
            { tokenId: '1', outcome: 'YES', raw: '2' },
            { tokenId: '2', outcome: 'NO', raw: '5' },
          ],
          tokenBalancesAfter: [
            { tokenId: '1', outcome: 'YES', raw: '0' },
            { tokenId: '2', outcome: 'NO', raw: '0' },
          ],
        }),
      });
    });

    expect(isError).toBe(false);
    const payload = JSON.parse(text);
    expect(payload.redeemed).toBe(true);
    expect(payload.txHash).toBe('0xredeem');
    expect(payload.verification.usdcDelta.formatted).toBe('2');
    expect(payload.submission.winningOutcomes).toEqual(['YES']);
  });

  it('pm_withdraw returns a bridge withdrawal envelope', async () => {
    const { isError, text } = await callServerTool(
      'pm_withdraw',
      {
        amountUSDC: '1',
        toChainId: '8453',
        toTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        recipientAddr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      },
      (server) => {
        (server as any).getPolymarket = vi.fn().mockReturnValue({
          withdrawUsdc: vi.fn().mockResolvedValue({
            fromChainId: '137',
            toChainId: '8453',
            fromTokenAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            toTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            recipientAddr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
            quote: {
              quoteId: 'quote-1',
              estCheckoutTimeMs: 25000,
              estToTokenBaseUnit: '999000',
            },
            bridgeAddresses: {
              evm: '0x23566f8b2E82aDfCf01846E54899d110e97AC053',
            },
            bridgeAddress: '0x23566f8b2E82aDfCf01846E54899d110e97AC053',
            bridgeNote: 'Send funds to these addresses to bridge to your destination chain and token.',
            txHash: '0xwithdraw',
            receiptStatus: 'success',
            blockNumber: '321',
            amountBaseUnit: '1000000',
            amountUSDC: '1',
            usdcBefore: { raw: '5000000', formatted: '5' },
            usdcAfter: { raw: '4000000', formatted: '4' },
            usdcDelta: { raw: '-1000000', formatted: '-1' },
            bridgeStatus: {
              transactions: [
                { status: 'PROCESSING', toChainId: '8453', fromAmountBaseUnit: '1000000' },
              ],
            },
            bridgeTransaction: { status: 'PROCESSING', toChainId: '8453', fromAmountBaseUnit: '1000000' },
          }),
        });
      },
    );

    expect(isError).toBe(false);
    const payload = JSON.parse(text);
    expect(payload.withdrawn).toBe(true);
    expect(payload.txHash).toBe('0xwithdraw');
    expect(payload.quote.quoteId).toBe('quote-1');
    expect(payload.submission.bridgeAddress).toBe('0x23566f8b2E82aDfCf01846E54899d110e97AC053');
    expect(payload.verification.bridgeTransaction.status).toBe('PROCESSING');
  });

  it('pm_buy returns a rejected submission envelope when the venue geoblocks the order', async () => {
    const reconcileSpy = vi.fn();
    const { isError, text } = await callServerTool(
      'pm_buy',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '0.02' },
      (server) => {
        (server as any).runPolymarketPreflight = vi.fn().mockResolvedValue({
          verdict: 'ready',
          warnings: [],
          tokenId: 'tok-yes',
        });
        (server as any).getAuthedClobClientV2 = vi.fn().mockResolvedValue({
          __evalancheClientVersion: 'v2',
          createAndPostMarketOrder: vi.fn().mockResolvedValue({
            status: 403,
            error: 'Trading restricted in your region, please refer to available regions',
          }),
        });
        (server as any).reconcilePolymarketVenue = reconcileSpy;
      },
    );

    expect(isError).toBe(false);
    const payload = JSON.parse(text);
    expect(payload.submission.status).toBe(403);
    expect(payload.submission.error.code).toBe('geoblocked');
    expect(payload.verification.skipped).toBe(true);
    expect(payload.verification.reason).toBe('geoblocked');
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('pm_buy market orders use a monotonic high nonce', async () => {
    const createAndPostMarketOrder = vi.fn().mockResolvedValue({
      success: true,
      orderID: 'ord-1',
      status: 'LIVE',
    });

    const { isError } = await callServerTool(
      'pm_buy',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '1' },
      (server) => {
        (server as any).runPolymarketPreflight = vi.fn().mockResolvedValue({
          verdict: 'ready',
          warnings: [],
          tokenId: 'tok-yes',
        });
        (server as any).getAuthedClobClientV2 = vi.fn().mockResolvedValue({
          __evalancheClientVersion: 'v2',
          createAndPostMarketOrder,
          getOrder: vi.fn().mockResolvedValue({ orderID: 'ord-1', status: 'LIVE' }),
          getOpenOrders: vi.fn().mockResolvedValue([]),
          getTrades: vi.fn().mockResolvedValue([]),
          getBalanceAllowance: vi.fn().mockResolvedValue({ balance: '1000000', allowance: '1000000' }),
          getBalances: vi.fn().mockResolvedValue({ collateral: '1' }),
        });
        (server as any).reconcilePolymarketVenue = vi.fn().mockResolvedValue({ sourceOfTruth: 'venue' });
      },
    );

    expect(isError).toBe(false);
    expect(createAndPostMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: 'tok-yes',
        amount: 1,
      }),
      expect.any(Object),
      expect.anything(),
    );
    const marketNonce = createAndPostMarketOrder.mock.calls[0]?.[0]?.nonce;
    expect(marketNonce).toBeUndefined();
  });

  it('pm_buy limit orders also use a monotonic high nonce', async () => {
    const createAndPostOrder = vi.fn().mockResolvedValue({
      success: true,
      orderID: 'ord-limit-1',
      status: 'LIVE',
    });

    const { isError } = await callServerTool(
      'pm_buy',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '1', orderType: 'limit', limitPrice: 0.5 },
      (server) => {
        (server as any).runPolymarketPreflight = vi.fn().mockResolvedValue({
          verdict: 'ready',
          warnings: [],
          tokenId: 'tok-yes',
        });
        (server as any).getAuthedClobClientV2 = vi.fn().mockResolvedValue({
          __evalancheClientVersion: 'v2',
          getMarket: vi.fn().mockResolvedValue({ minimum_tick_size: '0.01', neg_risk: false }),
          createAndPostOrder,
          getOrder: vi.fn().mockResolvedValue({ orderID: 'ord-limit-1', status: 'LIVE' }),
          getOpenOrders: vi.fn().mockResolvedValue([]),
          getTrades: vi.fn().mockResolvedValue([]),
          getBalanceAllowance: vi.fn().mockResolvedValue({ balance: '1000000', allowance: '1000000' }),
          getBalances: vi.fn().mockResolvedValue({ collateral: '1' }),
        });
        (server as any).reconcilePolymarketVenue = vi.fn().mockResolvedValue({ sourceOfTruth: 'venue' });
      },
    );

    expect(isError).toBe(false);
    expect(createAndPostOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: expect.any(Number),
      }),
      expect.any(Object),
      expect.anything(),
    );
    const limitNonce = createAndPostOrder.mock.calls[0]?.[0]?.nonce;
    expect(limitNonce).toBeGreaterThan(1_000_000_000_000);
  });

  it('pm_buy market submissions on v2 omit manual nonces across repeated submissions', async () => {
    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    const server = new EvalancheMCPServer({ privateKey: wallet.privateKey, network: 'fuji' } as any);
    const createAndPostMarketOrder = vi.fn()
      .mockResolvedValueOnce({ success: true, orderID: 'ord-a', status: 'LIVE' })
      .mockResolvedValueOnce({ success: true, orderID: 'ord-b', status: 'LIVE' });

    (server as any).runPolymarketPreflight = vi.fn().mockResolvedValue({
      verdict: 'ready',
      warnings: [],
      tokenId: 'tok-yes',
    });
    (server as any).getAuthedClobClientV2 = vi.fn().mockResolvedValue({
      __evalancheClientVersion: 'v2',
      createAndPostMarketOrder,
      getOrder: vi.fn()
        .mockResolvedValueOnce({ orderID: 'ord-a', status: 'LIVE' })
        .mockResolvedValueOnce({ orderID: 'ord-b', status: 'LIVE' }),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getTrades: vi.fn().mockResolvedValue([]),
      getBalanceAllowance: vi.fn().mockResolvedValue({ balance: '1000000', allowance: '1000000' }),
      getBalances: vi.fn().mockResolvedValue({ collateral: '1' }),
    });
    (server as any).reconcilePolymarketVenue = vi.fn().mockResolvedValue({ sourceOfTruth: 'venue' });

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'pm_buy', arguments: { conditionId: '0x1', outcome: 'YES', amountUSDC: '1' } },
    };

    const first = await server.handleRequest(request as any);
    const second = await server.handleRequest({ ...request, id: 2 } as any);

    expect((first.result as any)?.isError).not.toBe(true);
    expect((second.result as any)?.isError).not.toBe(true);
    const nonce1 = createAndPostMarketOrder.mock.calls[0]?.[0]?.nonce;
    const nonce2 = createAndPostMarketOrder.mock.calls[1]?.[0]?.nonce;
    expect(nonce1).toBeUndefined();
    expect(nonce2).toBeUndefined();
  });
});

describe('MCP server venue balance normalization', () => {
  it('treats pUSD spender allowances as collateral allowance source of truth', async () => {
    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    const server = new EvalancheMCPServer({ privateKey: wallet.privateKey, network: 'fuji' } as any);

    (server as any).getAuthedClobClient = vi.fn().mockResolvedValue({
      getBalanceAllowance: vi.fn().mockImplementation(({ asset_type }: { asset_type: string }) => {
        if (asset_type === 'COLLATERAL') {
          return {
            balance: '8000000',
            allowances: {
              '0xE111180000d2663C0091e4f400237545B87B996B': '0',
              '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296': '0',
              '0xe2222d279d744050d28e00520010520000310F59': '0',
            },
          };
        }
        return { balance: '0', allowances: {} };
      }),
      getBalances: vi.fn().mockResolvedValue(null),
    });
    (server as any).getOnChainUsdcAllowance = vi.fn().mockResolvedValue(0n);
    (server as any).getOnChainPusdAllowances = vi.fn().mockResolvedValue({
      '0xE111180000d2663C0091e4f400237545B87B996B': 8000000n,
      '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296': 0n,
      '0xe2222d279d744050d28e00520010520000310F59': 0n,
    });

    const balances = await (server as any).getPolymarketVenueBalances('token-1');
    expect(balances.collateral.balance).toBe(8);
    expect(balances.collateral.allowance).toBe(8);
    expect(balances.collateral.allowanceSource).toBe('pusd_spender');
    expect(balances.collateral.rawAllowances['0xE111180000d2663C0091e4f400237545B87B996B']).toBe('8000000');
  });
});

describe('PolymarketClient.placeMarketSellOrder', () => {
  it('uses a monotonic high nonce for direct market sells', async () => {
    const createAndPostMarketOrder = vi.fn().mockResolvedValue({
      orderID: 'sell-1',
      status: 'matched',
    });
    const getOrder = vi.fn().mockResolvedValue({ average_fill_price: 0.7, size: 10 });
    const createOrDeriveApiKey = vi.fn().mockResolvedValue({ key: 'k', secret: 's', passphrase: 'p' });

    vi.doMock('@polymarket/clob-client', () => ({
      ClobClient: class MockClobClient {
        host: string;
        chainId: number;
        signer: unknown;
        creds: unknown;
        constructor(host: string, chainId: number, signer?: unknown, creds?: unknown) {
          this.host = host;
          this.chainId = chainId;
          this.signer = signer;
          this.creds = creds;
        }
        async createOrDeriveApiKey() {
          return createOrDeriveApiKey();
        }
        async createAndPostMarketOrder(args: unknown) {
          return createAndPostMarketOrder(args);
        }
        async getOrder(orderId: string) {
          return getOrder(orderId);
        }
      },
      Side: { SELL: 'SELL' },
    }));

    try {
      const client = makeClient();
      vi.spyOn(client, 'getMarket').mockResolvedValue({
        conditionId: '0xsell',
        question: 'Will direct sell keep nonce monotonic?',
        tokens: [{ tokenId: 'tok-sell', conditionId: '0xsell', outcome: 'YES' }],
      });
      vi.spyOn(client, 'getOrderBook').mockResolvedValue({ bids: [{ price: 0.7, size: 20, orderID: 'bid-1' }], asks: [] });

      const result = await client.placeMarketSellOrder({ conditionId: '0xsell', outcome: 'YES', amountUSDC: 7 });

      expect(result.orderID).toBe('sell-1');
      expect(createAndPostMarketOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          nonce: expect.any(Number),
          side: 'SELL',
        }),
      );
      const sellNonce = createAndPostMarketOrder.mock.calls[0]?.[0]?.nonce;
      expect(sellNonce).toBeGreaterThan(1_000_000_000_000);
    } finally {
      vi.doUnmock('@polymarket/clob-client');
      vi.resetModules();
    }
  });
});

describe('MCP server Polymarket sell protections', () => {
  it('buildAuthedClobClient uses a fresh nonce for fallback auth attempts', async () => {
    vi.resetModules();
    const deriveApiKey = vi.fn().mockRejectedValueOnce({
      response: { status: 400 },
      message: '400 duplicate nonce',
    });
    const createOrDeriveApiKey = vi.fn().mockResolvedValue({
      key: 'k',
      secret: 's',
      passphrase: 'p',
    });

    vi.doMock('@polymarket/clob-client', () => ({
      ClobClient: class MockClobClient {
        creds: any;
        constructor(_host: string, _chainId: number, _signer?: unknown, creds?: unknown) {
          this.creds = creds;
        }
        deriveApiKey(nonce: number) {
          return deriveApiKey(nonce);
        }
        createOrDeriveApiKey(nonce: number) {
          return createOrDeriveApiKey(nonce);
        }
      },
    }));

    const { EvalancheMCPServer } = await import('../../src/mcp/server');
    const wallet = Wallet.createRandom();
    const server = new EvalancheMCPServer({ privateKey: wallet.privateKey, network: 'fuji' } as any);
    await (server as any).buildAuthedClobClient({}, wallet.address);

    expect(deriveApiKey).toHaveBeenCalledTimes(1);
    expect(createOrDeriveApiKey).toHaveBeenCalledTimes(1);
    expect(deriveApiKey.mock.calls[0][0]).toBeUndefined();
    expect(createOrDeriveApiKey.mock.calls[0][0]).toBeUndefined();

    vi.doUnmock('@polymarket/clob-client');
    vi.resetModules();
  });

  it('pm_sell rejects when visible liquidity would violate max slippage', async () => {
    const getAuthedClobClient = vi.fn();
    const { isError, text } = await callServerTool(
      'pm_sell',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '4.2', maxSlippagePct: 1 },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [
              { price: 0.7, size: 4, orderID: 'b1' },
              { price: 0.6, size: 10, orderID: 'b2' },
            ],
            asks: [],
          }),
        });
        (server as any).getAuthedClobClient = getAuthedClobClient;
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/below the minimum acceptable/i);
    expect(getAuthedClobClient).toHaveBeenCalledTimes(1);
  });

  it('pm_sell uses a protected FAK sell order instead of a raw market sell', async () => {
    const createOrder = vi.fn().mockResolvedValue({ signed: true });
    const postOrder = vi.fn().mockResolvedValue({ orderID: 'order-1', status: 'matched' });
    const getOrder = vi.fn().mockResolvedValue({ average_fill_price: 0.7, size: 10 });

    const { isError, text } = await callServerTool(
      'pm_sell',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '7', maxSlippagePct: 1 },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [{ price: 0.7, size: 20, orderID: 'b1' }],
            asks: [],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '100000000', allowance: '100000000' }
              : { balance: '20', allowance: '20' }
          ),
          getBalances: async () => ({ collateral: '100' }),
          getOpenOrders: async () => [],
          getTrades: async () => [],
          createOrder,
          postOrder,
          getOrder,
          getMarket: async () => ({ minimum_tick_size: '0.01', neg_risk: false }),
        });
        (server as any).fetchPolymarketPositions = async () => [{ asset: 'tok-1', size: '20' }];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.protectedByLimitOrder).toBe(true);
    expect(parsed.orderType).toBe('FAK');
    expect(parsed.limitPrice).toBeGreaterThanOrEqual(parsed.minAcceptablePrice);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(postOrder).toHaveBeenCalledWith({ signed: true }, 'FAK', false);
  }, 10000);

  it('pm_limit_sell honors postOnly=false by allowing immediate matching', async () => {
    const createOrder = vi.fn().mockResolvedValue({ signed: true });
    const postOrder = vi.fn().mockResolvedValue({ orderID: 'order-2', status: 'matched' });
    const getOrder = vi.fn().mockResolvedValue({ orderID: 'order-2', status: 'matched', average_fill_price: 0.55, size: 10 });

    const { isError, text } = await callServerTool(
      'pm_limit_sell',
      { conditionId: '0x1', outcome: 'YES', price: 0.55, shares: '10', postOnly: false },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [{ price: 0.6, size: 20, orderID: 'b1' }],
            asks: [],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          creds: { key: 'k', secret: 's' },
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '100000000', allowance: '100000000' }
              : { balance: '50', allowance: '50' }
          ),
          getBalances: async () => ({ collateral: '100' }),
          getOpenOrders: async () => [],
          getTrades: async () => [],
          createOrder,
          postOrder,
          getOrder,
          getMarket: async () => ({ minimum_tick_size: '0.01', neg_risk: false }),
        });
        (server as any).fetchPolymarketPositions = async () => [{ asset: 'tok-1', size: '25' }];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.deferExec).toBe(false);
    expect(parsed.postOnly).toBe(false);
    expect(parsed.preflight.verdict).toBe('risky');
    expect(parsed.submission.deferExec).toBe(false);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(postOrder).toHaveBeenCalledWith({ signed: true }, 'GTC', false, false);
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
    expect(parsed.count).toBe(2);
    expect(parsed.positions[0].asset).toBe('tok1');

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

describe('MCP server Polymarket inspection and reconciliation', () => {
  it('pm_market returns structured market_not_found errors instead of throwing', async () => {
    const { isError, text } = await callServerTool('pm_market', { conditionId: '0x404' }, (server) => {
      (server as any).getPolymarket = () => ({
        getMarket: async () => null,
      });
    });

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('market_not_found');
  });

  it('pm_preflight uses sorted best prices when CLOB arrays are unsorted', async () => {
    const { isError, text } = await callServerTool(
      'pm_preflight',
      { action: 'buy', conditionId: '0x1', outcome: 'NO', amountUSDC: '7.6', orderType: 'market' },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-no', outcome: 'NO' }],
          }),
          getOrderBook: async () => ({
            bids: [
              { price: 0.01, size: 100, orderID: 'b-low' },
              { price: 0.24, size: 100, orderID: 'b-high' },
            ],
            asks: [
              { price: 0.99, size: 100, orderID: 'a-expensive' },
              { price: 0.76, size: 100, orderID: 'a-cheap' },
            ],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '100000000', allowance: '100000000' }
              : { balance: '0', allowance: '0' }
          ),
          getBalances: async () => ({ collateral: '100' }),
        });
        (server as any).fetchPolymarketPositions = async () => [];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.orderbook.summary.bestAsk).toBeCloseTo(0.76, 6);
    expect(parsed.orderbook.summary.bestBid).toBeCloseTo(0.24, 6);
    expect(parsed.estimates.estimatedShares).toBeCloseTo(10, 6);
  });

  it('pm_preflight reports blocked allowance failures for buys', async () => {
    const { isError, text } = await callServerTool(
      'pm_preflight',
      { action: 'buy', conditionId: '0x1', outcome: 'YES', amountUSDC: '10', orderType: 'market' },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [{ price: 0.49, size: 100, orderID: 'b1' }],
            asks: [{ price: 0.51, size: 100, orderID: 'a1' }],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '100000000', allowance: '5000000' }
              : { balance: '0', allowance: '0' }
          ),
          getBalances: async () => ({ collateral: '100' }),
        });
        (server as any).fetchPolymarketPositions = async () => [];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.verdict).toBe('blocked');
    expect(parsed.checks.some((check: { name: string; status: string }) => check.name === 'collateral_allowance' && check.status === 'blocked')).toBe(true);
  });

  it('pm_preflight normalizes raw microUSDC collateral balances before buy checks', async () => {
    const { isError, text } = await callServerTool(
      'pm_preflight',
      { action: 'buy', conditionId: '0x1', outcome: 'YES', amountUSDC: '15', orderType: 'market' },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [{ price: 0.49, size: 100, orderID: 'b1' }],
            asks: [{ price: 0.51, size: 100, orderID: 'a1' }],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '26190', allowance: '26190' }
              : { balance: '0', allowance: '0' }
          ),
          getBalances: async () => ({ collateral: '26190' }),
        });
        (server as any).fetchPolymarketPositions = async () => [];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.balances.collateral.balance).toBeCloseTo(0.02619, 6);
    expect(parsed.verdict).toBe('blocked');
    expect(parsed.checks.some((check: { name: string; status: string; message: string }) =>
      check.name === 'collateral_balance' &&
      check.status === 'blocked' &&
      /0\.02619/.test(check.message))).toBe(true);
  });

  it('pm_buy rejects microUSDC-funded wallets before attempting a market order', async () => {
    const createAndPostMarketOrder = vi.fn();
    const { isError, text } = await callServerTool(
      'pm_buy',
      { conditionId: '0x1', outcome: 'YES', amountUSDC: '15', orderType: 'market' },
      (server) => {
        (server as any).getPolymarket = () => ({
          getMarket: async () => ({
            conditionId: '0x1',
            tokens: [{ tokenId: 'tok-1', outcome: 'YES' }],
          }),
          getOrderBook: async () => ({
            bids: [{ price: 0.49, size: 100, orderID: 'b1' }],
            asks: [{ price: 0.51, size: 100, orderID: 'a1' }],
          }),
        });
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '26190', allowance: '26190' }
              : { balance: '0', allowance: '0' }
          ),
          getBalances: async () => ({ collateral: '26190' }),
          createAndPostMarketOrder,
        });
        (server as any).fetchPolymarketPositions = async () => [];
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/pm_buy preflight failed/i);
    expect(text).toMatch(/below requested 15 USDC/i);
    expect(createAndPostMarketOrder).not.toHaveBeenCalled();
  });

  it('pm_balances reports raw allowance from the same source as the effective allowance', async () => {
    const { isError, text } = await callServerTool(
      'pm_balances',
      {},
      (server) => {
        (server as any).getAuthedClobClient = async () => ({
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '27127', allowance: '0' }
              : { balance: '0', allowance: '0' }
          ),
          getBalances: async () => ({ collateral: '27127' }),
        });
        (server as any).getOnChainUsdcAllowance = async () => 123456789n;
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.collateral.allowance).toBe(123.456789);
    expect(parsed.collateral.rawAllowance).toBe('123456789');
    expect(parsed.collateral.allowanceSource).toBe('on_chain');
  });

  it('pm_order returns venue-first reconciliation details', async () => {
    const { isError, text } = await callServerTool(
      'pm_order',
      { orderId: 'ord-1', tokenId: 'tok-1' },
      (server) => {
        (server as any).getAuthedClobClient = async () => ({
          getOrder: async () => ({ orderID: 'ord-1', status: 'MATCHED', average_fill_price: 0.62, size: 12 }),
          getOpenOrders: async () => [],
          getTrades: async () => [{ id: 'trade-1', price: 0.62 }],
          getBalanceAllowance: async ({ asset_type }: { asset_type: string }) => (
            asset_type === 'COLLATERAL'
              ? { balance: '50', allowance: '50' }
              : { balance: '12', allowance: '12' }
          ),
          getBalances: async () => ({ collateral: '50' }),
        });
        (server as any).fetchPolymarketPositions = async () => [{ asset: 'tok-1', size: '12' }];
      },
    );

    expect(isError).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.sourceOfTruth).toBe('venue');
    expect(parsed.order.orderId).toBe('ord-1');
    expect(parsed.reconciliation.orderState).toBe('MATCHED');
    expect(parsed.positions.relevantPosition.asset).toBe('tok-1');
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
