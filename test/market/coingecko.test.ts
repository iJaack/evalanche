import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoinGeckoClient } from '../../src/market/coingecko';
import { EvalancheError } from '../../src/utils/errors';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

function setupMock(stdout: string, stderr = '') {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      // promisify calls execFile with a callback
      if (cb) {
        cb(null, { stdout, stderr });
      }
      return undefined;
    },
  );
}

function setupError(code?: string, message = 'fail') {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: NodeJS.ErrnoException) => void) => {
      const err: NodeJS.ErrnoException = new Error(message);
      if (code) err.code = code;
      if (cb) cb(err);
      return undefined;
    },
  );
}

describe('CoinGeckoClient', () => {
  let client: CoinGeckoClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new CoinGeckoClient();
  });

  describe('price', () => {
    it('should return parsed price data', async () => {
      const data = { bitcoin: { usd: 50000 } };
      setupMock(JSON.stringify(data));
      const result = await client.price({ ids: 'bitcoin', vs: 'usd' });
      expect(result).toEqual(data);
    });

    it('should call cg with correct args', async () => {
      setupMock(JSON.stringify({}));
      await client.price({ ids: 'bitcoin', symbols: 'btc', vs: 'usd' });
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('price');
      expect(callArgs).toContain('--ids');
      expect(callArgs).toContain('bitcoin');
      expect(callArgs).toContain('--symbols');
      expect(callArgs).toContain('btc');
      expect(callArgs).toContain('-o');
      expect(callArgs).toContain('json');
    });
  });

  describe('trending', () => {
    it('should return trending data', async () => {
      const data = { coins: [{ item: { id: 'btc', name: 'Bitcoin', symbol: 'BTC', market_cap_rank: 1 } }] };
      setupMock(JSON.stringify(data));
      const result = await client.trending();
      expect(result.coins).toHaveLength(1);
      expect(result.coins![0].item.id).toBe('btc');
    });
  });

  describe('topGainersLosers', () => {
    it('should pass duration and losers flag', async () => {
      setupMock(JSON.stringify([]));
      await client.topGainersLosers({ duration: '24h', losers: true, topCoins: '300' });
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--duration');
      expect(callArgs).toContain('24h');
      expect(callArgs).toContain('--losers');
      expect(callArgs).toContain('--top-coins');
      expect(callArgs).toContain('300');
    });
  });

  describe('markets', () => {
    it('should return market coins', async () => {
      const data = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 50000, market_cap: 1e12, price_change_percentage_24h: 2.5 }];
      setupMock(JSON.stringify(data));
      const result = await client.markets({ total: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('bitcoin');
    });
  });

  describe('search', () => {
    it('should search for coins', async () => {
      const data = [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', market_cap_rank: 1 }];
      setupMock(JSON.stringify(data));
      const result = await client.search('bitcoin', 5);
      expect(result).toHaveLength(1);
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('search');
      expect(callArgs).toContain('bitcoin');
      expect(callArgs).toContain('--limit');
      expect(callArgs).toContain('5');
    });
  });

  describe('history', () => {
    it('should return historical data', async () => {
      const data = { prices: [[1700000000000, 50000]], market_caps: [], total_volumes: [] };
      setupMock(JSON.stringify(data));
      const result = await client.history({ id: 'bitcoin', days: '7' });
      expect(result.prices).toHaveLength(1);
    });

    it('should pass all options', async () => {
      setupMock(JSON.stringify({}));
      await client.history({ id: 'bitcoin', days: '30', from: '1000', to: '2000', interval: 'daily', vs: 'eur', ohlc: true });
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--days');
      expect(callArgs).toContain('--from');
      expect(callArgs).toContain('--to');
      expect(callArgs).toContain('--interval');
      expect(callArgs).toContain('--vs');
      expect(callArgs).toContain('--ohlc');
    });
  });

  describe('status', () => {
    it('should return status info', async () => {
      const data = { api_key: 'set', base_url: 'https://api.coingecko.com', tier: 'free' };
      setupMock(JSON.stringify(data));
      const result = await client.status();
      expect(result.tier).toBe('free');
    });
  });

  describe('error handling', () => {
    it('should throw MARKET_DATA_ERROR when cg CLI not found', async () => {
      setupError('ENOENT');
      await expect(client.price()).rejects.toThrow(EvalancheError);
      await expect(client.price()).rejects.toThrow('cg CLI not found');
    });

    it('should throw MARKET_DATA_ERROR on generic CLI errors', async () => {
      setupError(undefined, 'timeout exceeded');
      await expect(client.trending()).rejects.toThrow(EvalancheError);
      await expect(client.trending()).rejects.toThrow('cg CLI error');
    });

    it('should throw MARKET_DATA_ERROR on invalid JSON output', async () => {
      setupMock('not valid json');
      await expect(client.price()).rejects.toThrow(EvalancheError);
      await expect(client.price()).rejects.toThrow('Failed to parse');
    });
  });
});
