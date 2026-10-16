/**
 * Evalanche MCP Server CLI
 *
 * Usage:
 *   evalanche-mcp                           # stdio mode (default)
 *   EVALANCHE_MCP_HTTP_TOKEN=... evalanche-mcp --http --port 3402
 *
 * Environment:
 *   AGENT_PRIVATE_KEY  — Agent wallet private key (optional; overrides keychain/keystore)
 *   AGENT_MNEMONIC     — Agent wallet mnemonic (optional alternative to private key)
 *   EVALANCHE_SIGNER_URL — Remote signer base URL. Mutually exclusive with a local key.
 *   EVALANCHE_SIGNER_ADDRESS — Address of the remote signer wallet (required with SIGNER_URL)
 *   EVALANCHE_SIGNER_TOKEN — Bearer token sent to the remote signer
 *   EVALANCHE_ADDRESS  — Address-only mode when no key and no signer URL are set
 *   AGENT_ID           — ERC-8004 agent ID (optional, enables identity)
 *   AGENT_REGISTRY     — ERC-8004 registry address (optional, defaults to mainnet)
 *   AVALANCHE_NETWORK  — named EVM alias such as "avalanche", "base", or "robinhood" (default: "avalanche")
 *   AVALANCHE_RPC_URL  — Custom RPC URL (overrides network default)
 *   EVALANCHE_MCP_HTTP_TOKEN — Required bearer token for --http mode
 */

import { EvalancheMCPServer } from './server';
import type { EvalancheConfig } from '../agent';
import { resolveAgentSecrets } from '../secrets';

function parseArgs(): { http: boolean; port: number; host?: string; signerUrl?: string; signerAddress?: string } {
  const args = process.argv.slice(2);
  let http = false;
  let port = 3402;
  let host: string | undefined;
  let signerUrl: string | undefined;
  let signerAddress: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--http') http = true;
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
    if (args[i] === '--signer-url' && args[i + 1]) {
      signerUrl = args[i + 1];
      i++;
    }
    if (args[i] === '--signer-address' && args[i + 1]) {
      signerAddress = args[i + 1];
      i++;
    }
  }

  return { http, port, host, signerUrl, signerAddress };
}

async function buildConfig(flags: { signerUrl?: string; signerAddress?: string }): Promise<EvalancheConfig> {
  const signerUrl = flags.signerUrl || process.env.EVALANCHE_SIGNER_URL;
  const signerAddress = flags.signerAddress || process.env.EVALANCHE_SIGNER_ADDRESS;
  const readOnlyAddress = process.env.EVALANCHE_ADDRESS;
  const explicitLocalKey = Boolean(process.env.AGENT_PRIVATE_KEY || process.env.AGENT_MNEMONIC);
  const addressOnly = Boolean(readOnlyAddress) && !signerUrl && !explicitLocalKey;

  // Address-only mode must not consult the keychain or env fallback. A resolved
  // local key would silently replace the read-only wallet.
  const resolved = signerUrl || addressOnly
    ? { privateKey: undefined, mnemonic: undefined }
    : await resolveAgentSecrets();
  const privateKey = resolved.privateKey;
  const mnemonic = resolved.mnemonic;

  if (signerUrl && (privateKey || mnemonic || process.env.AGENT_PRIVATE_KEY || process.env.AGENT_MNEMONIC)) {
    process.stderr.write(
      'Error: --signer-url / EVALANCHE_SIGNER_URL is mutually exclusive with AGENT_PRIVATE_KEY and AGENT_MNEMONIC\n',
    );
    process.exit(1);
  }

  if (!privateKey && !mnemonic && !signerUrl && !readOnlyAddress) {
    process.stderr.write(
      'Error: no Evalanche credentials found (checked OpenClaw secrets, env vars, EvaWallet/EvaMain keychain, keystore). Set EVALANCHE_SIGNER_URL for a remote signer or EVALANCHE_ADDRESS for read-only mode.\n',
    );
    process.exit(1);
  }

  if (signerUrl && !signerAddress) {
    process.stderr.write(
      'Error: EVALANCHE_SIGNER_ADDRESS or --signer-address is required with a remote signer\n',
    );
    process.exit(1);
  }

  const config: EvalancheConfig = {};

  if (signerUrl && signerAddress) {
    config.signer = {
      url: signerUrl,
      address: signerAddress,
      tokenEnv: 'EVALANCHE_SIGNER_TOKEN',
    };
    config.address = signerAddress;
  } else if (privateKey) config.privateKey = privateKey;
  else if (mnemonic) config.mnemonic = mnemonic;
  else if (readOnlyAddress) config.address = readOnlyAddress;

  // Network
  const rpcUrl = process.env.AVALANCHE_RPC_URL;
  const networkName = process.env.AVALANCHE_NETWORK ?? 'avalanche';

  config.network = networkName as EvalancheConfig['network'];
  if (rpcUrl) config.rpcOverride = rpcUrl;

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
  const { http, port, host, signerUrl, signerAddress } = parseArgs();
  const config = await buildConfig({ signerUrl, signerAddress });
  const server = new EvalancheMCPServer(config);

  if (http) {
    server.startHTTP({ port, host, authToken: process.env.EVALANCHE_MCP_HTTP_TOKEN });
  } else {
    server.startStdio();
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
