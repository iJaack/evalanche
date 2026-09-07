#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { maybeWriteJson, parseArgs } from './release-helpers.mjs';

// Public, read-only endpoints. No wallet, credentials, signing or broadcast methods.
export const LIVE_READ_CHECKS = [
  { name: 'avalanche_chain_id', url: 'https://api.avax.network/ext/bc/C/rpc',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    validate: (data) => data.result === '0xa86a' && !data.error },
  { name: 'robinhood_chain_id', url: 'https://rpc.mainnet.chain.robinhood.com',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    validate: (data) => data.result === '0x1237' && !data.error },
  { name: 'hyperliquid_markets', url: 'https://api.hyperliquid.xyz/info', body: { type: 'meta' },
    validate: (data) => Array.isArray(data.universe) && data.universe.some((market) => typeof market.name === 'string') },
  { name: 'polymarket_markets', url: 'https://gamma-api.polymarket.com/markets?limit=1&closed=false',
    validate: (data) => Array.isArray(data) && data.some((market) => typeof market.conditionId === 'string') },
  { name: 'lifi_robinhood_quote', url: 'https://li.quest/v1/quote?' + new URLSearchParams({
    fromChain: '1', toChain: '4663',
    fromToken: '0x0000000000000000000000000000000000000000',
    toToken: '0x0000000000000000000000000000000000000000',
    fromAmount: '1000000000000000', fromAddress: '0x0000000000000000000000000000000000000001',
    integrator: 'evalanche',
  }), validate: (data) => typeof data.id === 'string' && data.action?.fromChainId === 1 && data.action?.toChainId === 4663 },
];

export async function runLiveReadSmoke({ checks = LIVE_READ_CHECKS, timeoutMs = 15_000, out } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('timeoutMs must be 1..60000');
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Packaged script may run outside git. */ }
  const results = await Promise.all(checks.map(async (check) => {
    const started = Date.now();
    let httpStatus;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(check.url, {
        method: check.body ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(check.body ? { 'Content-Type': 'application/json' } : {}) },
        body: check.body ? JSON.stringify(check.body) : undefined,
        signal: controller.signal, redirect: 'error',
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${httpStatus}`);
      }
      let size = 0;
      const chunks = [];
      if (!response.body) throw new Error('Empty response');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2_000_000) { controller.abort(); throw new Error('Response too large'); }
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || !check.validate(data)) throw new Error('Unexpected response schema or chain');
      return { name: check.name, ok: true, httpStatus, durationMs: Date.now() - started };
    } catch (error) {
      // Never retain provider response bodies, URLs with query strings, or credentials.
      const reason = controller.signal.aborted ? 'timeout or response limit' :
        httpStatus && httpStatus !== 200 ? `HTTP ${httpStatus}` :
        error instanceof SyntaxError ? 'Invalid JSON' :
        error?.message === 'Unexpected response schema or chain' ? error.message : 'Network or response error';
      return { name: check.name, ok: false, httpStatus, reason, durationMs: Date.now() - started };
    } finally { clearTimeout(timer); }
  }));
  return maybeWriteJson(out, {
    ok: results.every((check) => check.ok), checkedAt: new Date().toISOString(), commit,
    mode: 'live-read-only', checks: results,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  runLiveReadSmoke({ timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined, out: args.out })
    .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
