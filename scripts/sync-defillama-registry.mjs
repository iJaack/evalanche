#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const seedDir = path.join(root, 'src', 'holdings', 'registry', 'seed');
const protocolOut = path.join(seedDir, 'defillama.protocols.generated.json');
const sourcesOut = path.join(seedDir, 'defillama.sources.generated.json');

const SUPPORTED_CHAINS = new Map([
  ['ethereum', 'ethereum'],
  ['base', 'base'],
  ['arbitrum', 'arbitrum'],
  ['optimism', 'optimism'],
  ['polygon', 'polygon'],
  ['avalanche', 'avalanche'],
  ['bsc', 'bsc'],
  ['gnosis', 'gnosis'],
  ['sonic', 'sonic'],
  ['linea', 'linea'],
  ['scroll', 'scroll'],
  ['celo', 'celo'],
  ['mantle', 'mantle'],
]);

function normalizeSlug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeChain(value) {
  const lowered = String(value ?? '').trim().toLowerCase();
  return SUPPORTED_CHAINS.get(lowered);
}

function protocolRecord(protocol) {
  const chains = Array.from(new Set(
    (Array.isArray(protocol.chains) ? protocol.chains : [])
      .map(normalizeChain)
      .filter(Boolean),
  ));
  if (chains.length === 0) return null;

  return {
    protocolId: normalizeSlug(protocol.slug || protocol.name),
    name: String(protocol.name),
    slug: normalizeSlug(protocol.slug || protocol.name),
    category: String(protocol.category ?? 'defi').toLowerCase(),
    chains,
    website: typeof protocol.url === 'string' ? protocol.url : undefined,
    aliases: [protocol.slug, protocol.symbol].filter(Boolean).map((value) => String(value).toLowerCase()),
    source: 'defillama',
  };
}

function sourceRecord(pool) {
  const chain = normalizeChain(pool.chain);
  const protocolId = normalizeSlug(pool.project);
  if (!chain || !protocolId) return null;
  const tokens = Array.isArray(pool.underlyingTokens) ? pool.underlyingTokens : [];
  const lowerTokens = tokens.filter((item) => typeof item === 'string' && item.startsWith('0x'));
  if (lowerTokens.length === 0) return null;

  return {
    sourceId: `defillama-${protocolId}-${normalizeSlug(pool.poolMeta || pool.symbol || pool.pool) || pool.pool}`,
    protocolId,
    chain,
    sourceKind: 'lp_receipt',
    detectorId: 'lp_receipt_detector',
    role: pool.poolMeta || pool.symbol || 'pool',
    underlyingTokens: lowerTokens.map((token) => `${chain}:${token}`),
    priority: 10,
    source: 'defillama',
  };
}

async function main() {
  const [protocols, poolsPayload] = await Promise.all([
    fetch('https://api.llama.fi/protocols').then((res) => res.json()),
    fetch('https://yields.llama.fi/pools').then((res) => res.json()),
  ]);

  const normalizedProtocols = Array.from(new Map(
    protocols
      .map(protocolRecord)
      .filter(Boolean)
      .map((record) => [record.protocolId, record]),
  ).values());

  const normalizedSources = Array.from(new Map(
    (Array.isArray(poolsPayload?.data) ? poolsPayload.data : [])
      .map(sourceRecord)
      .filter(Boolean)
      .map((record) => [record.sourceId, record]),
  ).values());

  await fs.mkdir(seedDir, { recursive: true });
  await fs.writeFile(protocolOut, `${JSON.stringify(normalizedProtocols, null, 2)}\n`);
  await fs.writeFile(sourcesOut, `${JSON.stringify(normalizedSources, null, 2)}\n`);

  console.log(JSON.stringify({
    protocols: normalizedProtocols.length,
    sources: normalizedSources.length,
    protocolOut,
    sourcesOut,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
