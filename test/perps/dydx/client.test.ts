import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalancheError } from '../../../src/utils/errors';

const {
  mockPlaceOrder,
  mockCancelOrder,
  mockDepositToSubaccount,
  mockWithdrawFromSubaccount,
  mockGetSubaccount,
  mockGetSubaccountPerpetualPositions,
  mockGetSubaccountOrders,
  mockGetPerpetualMarkets,
} = vi.hoisted(() => ({
  mockPlaceOrder: vi.fn(),
  mockCancelOrder: vi.fn(),
  mockDepositToSubaccount: vi.fn(),
  mockWithdrawFromSubaccount: vi.fn(),
  mockGetSubaccount: vi.fn(),
  mockGetSubaccountPerpetualPositions: vi.fn(),
  mockGetSubaccountOrders: vi.fn(),
  mockGetPerpetualMarkets: vi.fn(),
}));

vi.mock('@dydxprotocol/v4-client-js', () => {
  const mockWallet = { address: 'dydx1testaddress' };
  const mockComposite = {
    indexerClient: {
      account: {
        getSubaccount: mockGetSubaccount,
        getSubaccountPerpetualPositions: mockGetSubaccountPerpetualPositions,
        getSubaccountOrders: mockGetSubaccountOrders,
      },
      markets: {
        getPerpetualMarkets: mockGetPerpetualMarkets,
      },
    },
    placeOrder: mockPlaceOrder,
    cancelOrder: mockCancelOrder,
    depositToSubaccount: mockDepositToSubaccount,
    withdrawFromSubaccount: mockWithdrawFromSubaccount,
  };

  return {
    BECH32_PREFIX: 'dydx',
    LocalWallet: {
      fromMnemonic: vi.fn().mockResolvedValue(mockWallet),
    },
    CompositeClient: {
      connect: vi.fn().mockResolvedValue(mockComposite),
    },
    SubaccountClient: {
      forLocalWallet: vi.fn().mockReturnValue({ address: 'dydx1testaddress', subaccountNumber: 0 }),
    },
    Network: {
      mainnet: vi.fn().mockReturnValue({ kind: 'mainnet' }),
    },
    OrderSide: { BUY: 'BUY', SELL: 'SELL' },
    OrderType: { MARKET: 'MARKET', LIMIT: 'LIMIT' },
    OrderTimeInForce: { GTT: 'GTT', IOC: 'IOC', FOK: 'FOK' },
  };
});

// Import after mock to ensure mock is applied
import { DydxClient } from '../../../src/perps/dydx/client';

describe('DydxClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSubaccount.mockResolvedValue({ subaccount: { equity: '1000', freeCollateral: '700' } });
    mockGetSubaccountPerpetualPositions.mockResolvedValue({
      positions: [
        {
          ticker: 'ETH-USD',
          side: 'LONG',
          size: '0.5',
          entryPrice: '3000',
          unrealizedPnl: '42',
        },
      ],
    });
    mockGetSubaccountOrders.mockResolvedValue({
      orders: [{ ticker: 'ETH-USD', clientId: 123, orderFlags: 32, status: 'OPEN' }],
    });
    mockGetPerpetualMarkets.mockResolvedValue({
      markets: [
        {
          ticker: 'ETH-USD',
          status: 'ACTIVE',
          oraclePrice: '3000',
          volume24H: '1000000',
          openInterest: '500000',
          initialMarginFraction: '0.1',
        },
      ],
    });
    mockPlaceOrder.mockResolvedValue({ transactionHash: '0xordertx' });
    mockCancelOrder.mockResolvedValue({ transactionHash: '0xcanceltx' });
    mockDepositToSubaccount.mockResolvedValue({ transactionHash: '0xdeposit' });
    mockWithdrawFromSubaccount.mockResolvedValue({ transactionHash: '0xwithdraw' });
  });

  it('initializes from mnemonic and returns address', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');
    await client.connect();
    await expect(client.getAddress()).resolves.toBe('dydx1testaddress');
  });

  it('lists markets and checks existence', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');
    const markets = await client.getMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0].ticker).toBe('ETH-USD');
    await expect(client.hasMarket('ETH-USD')).resolves.toBe(true);
    await expect(client.hasMarket('BTC-USD')).resolves.toBe(false);
  });

  it('places market and limit orders', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');

    const marketOrderId = await client.placeMarketOrder({ market: 'ETH-USD', side: 'BUY', size: '0.1' });
    const limitOrderId = await client.placeLimitOrder({
      market: 'ETH-USD',
      side: 'SELL',
      size: '0.1',
      price: '3100',
      timeInForce: 'GTT',
    });

    expect(marketOrderId).toMatch(/^ETH-USD:/);
    expect(limitOrderId).toMatch(/^ETH-USD:/);
    expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
  });

  it('returns positions, balance, and orders', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');

    const positions = await client.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].market).toBe('ETH-USD');

    await expect(client.getBalance()).resolves.toBe('1000');

    const orders = await client.getOrders('OPEN');
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe('ETH-USD:123:32');
  });

  it('cancels orders and closes positions', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');

    await client.cancelOrder('ETH-USD:123:32');
    expect(mockCancelOrder).toHaveBeenCalledWith(expect.anything(), 123, 32, 'ETH-USD');

    const closeOrderId = await client.closePosition('ETH-USD');
    expect(closeOrderId).toMatch(/^ETH-USD:/);
  });

  it('throws for invalid market order market', async () => {
    const client = new DydxClient('test test test test test test test test test test test junk');
    await expect(client.placeMarketOrder({ market: 'BAD-USD', side: 'BUY', size: '1' }))
      .rejects.toBeInstanceOf(EvalancheError);
  });
});

