/**
 * Lightweight CoinGecko client.
 *
 * The original CLI-backed implementation appears to have been lost; this
 * restores the class surface used by the MCP server and package exports.
 */

import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';

interface PriceParams {
  ids: string;
  vsCurrencies?: string;
  include24hrChange?: boolean;
  include24hrVol?: boolean;
  includeMarketCap?: boolean;
}

interface MarketsParams {
  vsCurrency?: string;
  order?: string;
  perPage?: number;
  page?: number;
}

interface TopMoversParams {
  duration?: string;
  topCoins?: string;
}

interface HistoryParams {
  id: string;
  date: string;
  localization?: boolean;
}

export class CoinGeckoClient {
  private readonly baseUrl: string;

  constructor(baseUrl = 'https://api.coingecko.com/api/v3') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await safeFetch(url.toString(), { timeoutMs: 8_000, maxBytes: 1_000_000 });
    } catch (error) {
      throw new EvalancheError(
        `CoinGecko request failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.NETWORK_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      throw new EvalancheError(
        `CoinGecko request failed with status ${response.status}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
      );
    }

    return await response.json() as T;
  }

  async price(params: PriceParams): Promise<unknown> {
    return this.request('/simple/price', {
      ids: params.ids,
      vs_currencies: params.vsCurrencies ?? 'usd',
      include_24hr_change: params.include24hrChange ?? false,
      include_24hr_vol: params.include24hrVol ?? false,
      include_market_cap: params.includeMarketCap ?? false,
    });
  }

  async trending(): Promise<unknown> {
    return this.request('/search/trending');
  }

  async topGainersLosers(params: TopMoversParams = {}): Promise<unknown> {
    return this.request('/coins/top_gainers_losers', {
      vs_currency: 'usd',
      duration: params.duration ?? '24h',
      top_coins: params.topCoins ?? '300',
    });
  }

  async markets(params: MarketsParams = {}): Promise<unknown> {
    return this.request('/coins/markets', {
      vs_currency: params.vsCurrency ?? 'usd',
      order: params.order ?? 'market_cap_desc',
      per_page: params.perPage ?? 25,
      page: params.page ?? 1,
    });
  }

  async search(query: string): Promise<unknown> {
    return this.request('/search', { query });
  }

  async history(params: HistoryParams): Promise<unknown> {
    return this.request(`/coins/${params.id}/history`, {
      date: params.date,
      localization: params.localization ?? false,
    });
  }

  async status(): Promise<unknown> {
    return {
      provider: 'coingecko',
      mode: 'http',
      baseUrl: this.baseUrl,
      ok: true,
    };
  }
}
