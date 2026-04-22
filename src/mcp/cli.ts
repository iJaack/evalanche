/**
 * Evalanche MCP Server CLI
 *
 * Usage:
 *   evalanche-mcp                           # stdio mode (default)
 *   evalanche-mcp --http --port 3402        # HTTP mode
 *
 * Environment:
 *   AGENT_PRIVATE_KEY  — Agent wallet private key (optional; overrides keychain/keystore)
 *   AGENT_MNEMONIC     — Agent wallet mnemonic (optional alternative to private key)
 *   AGENT_ID           — ERC-8004 agent ID (optional, enables identity)
 *   AGENT_REGISTRY     — ERC-8004 registry address (optional, defaults to mainnet)
 *   AVALANCHE_NETWORK  — "avalanche" | "fuji" (default: "avalanche")
 *   AVALANCHE_RPC_URL  — Custom RPC URL (overrides network default)
 */

import { EvalancheMCPServer } from './server';
import type { EvalancheConfig } from '../agent';
import { resolveAgentSecrets } from '../secrets';

function parseArgs(): { http: boolean; port: number } {
  const args = process.argv.slice(2);
  let http = false;
  let port = 3402;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--http') http = true;
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { http, port };
}

async function buildConfig(): Promise<EvalancheConfig> {
  const resolved = await resolveAgentSecrets();
  const privateKey = resolved.privateKey;
  const mnemonic = resolved.mnemonic;

  if (!privateKey && !mnemonic) {
    process.stderr.write(
      'Error: no Evalanche credentials found (checked OpenClaw secrets, env vars, EvaWallet/EvaMain keychain, keystore)\n',
    );
    process.exit(1);
  }

  const config: EvalancheConfig = {};

  if (privateKey) config.privateKey = privateKey;
  else if (mnemonic) config.mnemonic = mnemonic;

  // Network
  const rpcUrl = process.env.AVALANCHE_RPC_URL;
  const networkName = process.env.AVALANCHE_NETWORK ?? 'avalanche';

  if (rpcUrl) {
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
    const chainId = chainIdMap[networkName] ?? 43114;
    config.network = { rpcUrl, chainId };
  } else {
    config.network = networkName as EvalancheConfig['network'];
  }

  // Identity (optional)
  const agentId = process.env.AGENT_ID;
  if (agentId) {
    config.identity = {
      agentId,
      registry: process.env.AGENT_REGISTRY,
    };
  }

  return config;
}

async function main(): Promise<void> {
  const { http, port } = parseArgs();
  const config = await buildConfig();
  const server = new EvalancheMCPServer(config);

  if (http) {
    server.startHTTP(port);
  } else {
    server.startStdio();
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
