/**
 * evalanche-signer — holds the treasury key and signs only approved intents.
 *
 * The box launch key comes from EVALANCHE_SIGNER_PRIVATE_KEY. The process
 * removes that variable after reading it. An encrypted keystore remains
 * available for other installs. The key is not written to the config or logs.
 * The bearer token comes from EVALANCHE_SIGNER_TOKEN. Neither belongs in the
 * config file. The process binds to 127.0.0.1 or a unix socket.
 */

import { readFile } from 'node:fs/promises';
import { assertSecureParents, readSecureFile } from './secure-path';
import { startSignerServer, type SignerServerOptions } from './server';

interface CliArgs {
  config?: string;
  dryRun: boolean;
  host?: string;
  port?: number;
  socket?: string;
  initNonces: boolean;
  allowInsecureFilePermissions: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, initNonces: false, allowInsecureFilePermissions: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--init-nonces') args.initNonces = true;
    else if (token === '--allow-insecure-file-permissions') args.allowInsecureFilePermissions = true;
    else if (token === '--config' && next) {
      args.config = next;
      i += 1;
    } else if (token === '--host' && next) {
      args.host = next;
      i += 1;
    } else if (token === '--port' && next) {
      args.port = Number(next);
      i += 1;
    } else if (token === '--socket' && next) {
      args.socket = next;
      i += 1;
    } else if (token === '--help' || token === '-h') {
      process.stdout.write('evalanche-signer --config signer.json [--dry-run] [--init-nonces] [--host 127.0.0.1] [--port 7410] [--socket /path.sock]\n');
      process.stdout.write('--allow-insecure-file-permissions is for tests only. Config and keys must be root-owned. State directories must be mode 0700 and owned by the signer user.\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('Missing --config <file>');
  let configText: string;
  if (args.allowInsecureFilePermissions) {
    configText = await readFile(args.config, 'utf8');
  } else {
    await assertSecureParents(args.config);
    configText = await readSecureFile(args.config);
  }
  const raw = JSON.parse(configText) as SignerServerOptions & {
    token?: string;
    privateKey?: string;
    verifierPublicKeyPath?: string;
  };
  if (raw.token || raw.privateKey) {
    throw new Error('Refusing to read token or privateKey from the config file. Use EVALANCHE_SIGNER_TOKEN and EVALANCHE_SIGNER_PRIVATE_KEY or a keystore.');
  }
  const token = process.env.EVALANCHE_SIGNER_TOKEN;
  if (!token) throw new Error('EVALANCHE_SIGNER_TOKEN is required');
  const server = await startSignerServer({
    ...raw,
    token,
    dryRun: args.dryRun || raw.dryRun,
    host: args.host ?? raw.host,
    port: args.port ?? raw.port,
    socketPath: args.socket ?? raw.socketPath,
    initNonces: args.initNonces,
    allowInsecureFilePermissions: args.allowInsecureFilePermissions,
    configPath: args.config,
    verifierPublicKeyPath: raw.verifierPublicKeyPath,
  });
  process.stderr.write(`evalanche-signer listening on ${server.endpoint} for ${server.address}\n`);
}

main().catch((error) => {
  process.stderr.write(`evalanche-signer: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
