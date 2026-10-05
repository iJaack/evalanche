#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, maybeWriteJson, parseArgs } from './release-helpers.mjs';

export async function runReleaseSmoke({
  rootDir = DEFAULT_ROOT,
  moduleExports,
  out,
} = {}) {
  const mod = moduleExports ?? await import(pathToFileURL(path.join(rootDir, 'dist', 'index.mjs')).href);
  const {
    EvalancheMCPServer,
    HoldingsClient,
    LiFiClient,
    NATIVE_TOKEN,
    PolymarketClient,
    HyperliquidClient,
  } = mod;

  const wallet = {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    getAddress: async () => '0x1234567890abcdef1234567890abcdef12345678',
    signMessage: async () => '0x',
    sendTransaction: async () => ({ hash: '0x', wait: async () => ({ status: 1 }) }),
    connect() { return this; },
    signTypedData: async () => `0x${'1'.repeat(128)}1b`,
  };

  const originalFetch = globalThis.fetch;
  const queuedResponses = [];
  globalThis.fetch = async () => {
    const next = queuedResponses.shift();
    if (!next) throw new Error('Unexpected fetch call in release smoke');
    return next;
  };

  const checks = [];
  try {
    const server = new EvalancheMCPServer({
      privateKey: `0x${'1'.repeat(64)}`,
      network: 'avalanche',
    });
    const init = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const tools = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    checks.push({ name: 'mcp_initialize', ok: init?.result?.serverInfo?.name === 'evalanche' });
    checks.push({ name: 'mcp_tools_list', ok: Array.isArray(tools?.result?.tools) && tools.result.tools.length > 0 });

    const holdingsClient = new HoldingsClient({
      address: wallet.address,
      provider: { getBalance: async () => 0n },
      getChainInfo: () => ({ id: 43114, name: 'Avalanche', currency: { symbol: 'AVAX' } }),
      switchNetwork() { return this; },
      async hyperliquid() { return { getAccountState: async () => ({ positions: [] }) }; },
    });
    const holdings = await holdingsClient.scan({ include: [] });
    checks.push({ name: 'holdings_boot', ok: Array.isArray(holdings.holdings) && holdings.summary.totalHoldings === 0 });

    queuedResponses.push({
      ok: true,
      json: async () => ({
        id: 'smoke-quote',
        tool: 'across',
        action: {
          fromChainId: 1,
          toChainId: 43114,
          fromToken: { address: NATIVE_TOKEN },
          toToken: { address: NATIVE_TOKEN },
          fromAmount: '100000000000000000',
        },
        estimate: {
          toAmount: '99000000000000000',
          gasCosts: [{ amountUSD: '2.50' }],
          executionDuration: 120,
        },
      }),
    });
    const lifiClient = new LiFiClient(wallet);
    const quote = await lifiClient.getQuote({
      fromChainId: 1,
      toChainId: 43114,
      fromToken: NATIVE_TOKEN,
      toToken: NATIVE_TOKEN,
      fromAmount: '0.1',
      fromAddress: wallet.address,
    });
    checks.push({ name: 'lifi_quote_read', ok: quote.id === 'smoke-quote' });

    queuedResponses.push({
      ok: true,
      json: async () => ({ bids: [{ price: 0.51, size: 10, orderID: 'b1' }], asks: [] }),
    });
    const polymarketClient = new PolymarketClient(wallet);
    const orderBook = await polymarketClient.getOrderBook('token-1');
    checks.push({ name: 'polymarket_orderbook_read', ok: orderBook.bids.length === 1 });

    queuedResponses.push({
      ok: true,
      json: async () => ([
        {
          universe: [{ name: 'BTC', maxLeverage: 50, marginTableId: 1, szDecimals: 5 }],
        },
        [{ oraclePx: '100000', dayNtlVlm: '1000000', openInterest: '100' }],
      ]),
    });
    const hyperliquidClient = new HyperliquidClient({ address: wallet.address });
    const markets = await hyperliquidClient.getMarkets();
    checks.push({ name: 'hyperliquid_markets_read', ok: markets.length === 1 && markets[0].ticker === 'BTC' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const result = {
    ok: checks.every((check) => check.ok),
    checks,
  };
  if (!result.ok) {
    await maybeWriteJson(out, result);
    throw new Error('Release smoke failed');
  }

  return maybeWriteJson(out, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runReleaseSmoke({ out: args.out });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
