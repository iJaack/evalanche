#!/usr/bin/env node
/**
 * Runs inside the production layout as the dedicated signer user.
 * argv[2] is "sign" or "bad-mode".
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const prefix = process.env.EVALANCHE_LAYOUT_PREFIX;
const configDir = process.env.EVALANCHE_LAYOUT_CONFIG;
const stateDir = process.env.EVALANCHE_LAYOUT_STATE;
if (!prefix || !configDir || !stateDir) {
  console.error('layout paths are not set');
  process.exit(1);
}

const require = createRequire(join(prefix, 'dist/index.js'));
const {
  computeApprovedTxHash,
  signVerifierApproval,
  startSignerServer,
} = require(join(prefix, 'dist/index.js'));
const { Wallet } = require('ethers');

const mode = process.argv[2];
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new Wallet(KEY).address;
const chainId = 43114;
const payee = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const verifierPublicKey = readFileSync(join(configDir, 'verifier.pub'), 'utf8').trim();
const verifierPrivateKey = process.env.EVALANCHE_LAYOUT_VERIFIER_SECRET ?? '';
if (!verifierPrivateKey) {
  console.error('verifier secret is not set');
  process.exit(1);
}

let server;
try {
  server = await startSignerServer({
    keystorePath: join(configDir, 'keystore.json'),
    keystorePasswordEnv: 'EVALANCHE_SIGNER_KEYSTORE_PASSWORD',
    verifierPublicKeyPath: join(configDir, 'verifier.pub'),
    configPath: join(configDir, 'config.json'),
    verifierPublicKey,
    token: 'root-layout',
    auditLogPath: join(stateDir, 'audit.jsonl'),
    nonceStorePath: join(stateDir, 'nonces.json'),
    initNonces: mode === 'sign',
    allowInsecureFilePermissions: false,
    chainId,
    host: '127.0.0.1',
    port: 0,
    simulate: async () => ({ success: true }),
    allow: { [chainId]: [{ address: payee, selectors: ['0x'], roles: ['recipient'] }] },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (mode === 'bad-mode') {
  console.error('signer started with a state directory that should have been rejected');
  await server.close();
  process.exit(2);
}

const tx = {
  to: payee,
  value: '1',
  data: '0x',
  chainId,
  nonce: '0',
  gasLimit: '100000',
  maxFeePerGas: '0',
  maxPriorityFeePerGas: '0',
  gasPrice: '25000000000',
  type: 0,
};
const now = Date.now();
const intent = {
  version: '1',
  intentId: 'root-layout',
  nonce: '1',
  createdAt: now,
  expiresAt: now + 300_000,
  wallet,
  chainId,
  venue: 'avalanche',
  action: 'transfer',
  routeHash: computeApprovedTxHash(tx),
  tx,
  tokenIn: { address: '0x0000000000000000000000000000000000000000', symbol: 'AVAX', decimals: 18 },
  amountIn: '1',
};
const approval = signVerifierApproval({
  intent,
  verifierPrivateKey,
  verifierPublicKey,
});
try {
  const result = await server.handle({
    requestId: 'root-layout',
    kind: 'transaction',
    chainId,
    from: wallet,
    to: payee,
    value: '1',
    data: '0x',
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: '0',
    maxPriorityFeePerGas: '0',
    nonce: 0,
    type: 0,
    intent: 'x',
    structuredIntent: intent,
    approval,
  });
  if (!result.signedTransaction) throw new Error('missing signature');
  console.log('SIGNED');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await server.close();
}
