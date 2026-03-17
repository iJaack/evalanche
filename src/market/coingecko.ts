import { execFile } from "child_process";
import { promisify } from "util";
import { EvalancheError, EvalancheErrorCode } from "../utils/errors";

const execFileAsync = promisify(execFile);

export interface CoinPrice { [id: string]: { [currency: string]: number } }
export interface TrendingData {
  coins?: Array<{ item: { id: string; name: string; symbol: string; market_cap_rank: number } }>;
  nfts?: unknown[]; categories?: unknown[];
}
export interface MarketCoin {
  id: string; symbol: string; name: string; current_price: number;
  market_cap: number; price_change_percentage_24h: number; [key: string]: unknown;
}
export interface SearchCoin { id: string; name: string; symbol: string; market_cap_rank: number; [key: string]: unknown }
export interface HistoryData {
  prices?: Array<[number, number]>; market_caps?: Array<[number, number]>;
  total_volumes?: Array<[number, number]>; [key: string]: unknown;
}
export interface CgStatus { api_key?: string; base_url?: string; tier?: string; [key: string]: unknown }

export class CoinGeckoClient {
  async price(opts: { ids?: string; symbols?: string; vs?: string } = {}): Promise<CoinPrice> {
    const args = ["price"];
    if (opts.ids) args.push("--ids", opts.ids);
    if (opts.symbols) args.push("--symbols", opts.symbols);
    if (opts.vs) args.push("--vs", opts.vs);
    return this.exec<CoinPrice>(args);
  }
  async trending(): Promise<TrendingData> { return this.exec<TrendingData>(["trending"]); }
  async topGainersLosers(opts: { duration?: string; losers?: boolean; topCoins?: string } = {}): Promise<unknown> {
    const args = ["top-gainers-losers"];
    if (opts.duration) args.push("--duration", opts.duration);
    if (opts.losers) args.push("--losers");
    if (opts.topCoins) args.push("--top-coins", opts.topCoins);
    return this.exec(args);
  }
  async markets(opts: { total?: number; category?: string; order?: string; vs?: string } = {}): Promise<MarketCoin[]> {
    const args = ["markets"];
    if (opts.total != null) args.push("--total", String(opts.total));
    if (opts.category) args.push("--category", opts.category);
    if (opts.order) args.push("--order", opts.order);
    if (opts.vs) args.push("--vs", opts.vs);
    return this.exec<MarketCoin[]>(args);
  }
  async search(query: string, limit?: number): Promise<SearchCoin[]> {
    const args = ["search", query];
    if (limit != null) args.push("--limit", String(limit));
    return this.exec<SearchCoin[]>(args);
  }
  async history(opts: { id: string; days?: string; date?: string; from?: string; to?: string; interval?: string; vs?: string; ohlc?: boolean }): Promise<HistoryData> {
    const args = ["history", opts.id];
    if (opts.days) args.push("--days", opts.days);
    if (opts.date) args.push("--date", opts.date);
    if (opts.from) args.push("--from", opts.from);
    if (opts.to) args.push("--to", opts.to);
    if (opts.interval) args.push("--interval", opts.interval);
    if (opts.vs) args.push("--vs", opts.vs);
    if (opts.ohlc) args.push("--ohlc");
    return this.exec<HistoryData>(args);
  }
  async status(): Promise<CgStatus> { return this.exec<CgStatus>(["status"]); }

  private async exec<T>(args: string[]): Promise<T> {
    args.push("-o", "json");
    try {
      const { stdout, stderr } = await execFileAsync("cg", args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      try { return JSON.parse(stdout) as T; }
      catch { throw new EvalancheError(`Failed to parse cg output: ${stderr || stdout}`, EvalancheErrorCode.MARKET_DATA_ERROR); }
    } catch (err) {
      if (err instanceof EvalancheError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new EvalancheError("cg CLI not found. Install via: brew install coingecko/coingecko-cli/cg", EvalancheErrorCode.MARKET_DATA_ERROR);
      throw new EvalancheError(`cg CLI error: ${e.message}`, EvalancheErrorCode.MARKET_DATA_ERROR, e instanceof Error ? e : undefined);
    }
  }
}
