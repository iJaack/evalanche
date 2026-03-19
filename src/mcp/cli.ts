/**
 * Evalanche MCP Server CLI
 *
 * Usage:
 *   evalanche-mcp                           # stdio mode (default)
 *   evalanche-mcp --http --port 3402        # HTTP mode
 *
 * Environment:
 *   AGENT_PRIVATE_KEY  — Agent wallet private key (required)
 *   AGENT_MNEMONIC     — Agent wallet mnemonic (alternative to private key)
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
      'Error: Set AGENT_PRIVATE_KEY or AGENT_MNEMONIC environment variable\n',
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
    const chainId = networkName === 'fuji' ? 43113 : 43114;
    config.network = { rpcUrl, chainId };
  } else {
    config.network = networkName as 'avalanche' | 'fuji';
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
