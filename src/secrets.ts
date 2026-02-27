/**
 * OpenClaw External Secrets integration for Evalanche.
 *
 * When evalanche runs inside an OpenClaw environment, it can resolve
 * secret references via the `openclaw secrets` CLI instead of reading
 * raw env vars or keystore files.
 *
 * This is optional: if OpenClaw is not installed or the secret ref is
 * not found, evalanche falls back to the standard keystore/env flow.
 *
 * Secret refs follow the pattern: @secret:<name>
 * e.g. AGENT_PRIVATE_KEY=@secret:eva-wallet-key
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Check if OpenClaw CLI is available on PATH */
async function isOpenClawAvailable(): Promise<boolean> {
  try {
    await execFileAsync('openclaw', ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a secret value via `openclaw secrets get <name>`.
 * Returns null if OpenClaw is unavailable or the secret is not found.
 */
async function resolveOpenClawSecret(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('openclaw', ['secrets', 'get', name, '--raw'], {
      timeout: 5000,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse a secret ref string. Returns the secret name if it's a ref,
 * or null if it's a plain value (not a ref).
 *
 * @example
 * parseSecretRef('@secret:eva-wallet-key') // → 'eva-wallet-key'
 * parseSecretRef('0xabc123...')             // → null (plain value)
 */
export function parseSecretRef(value: string): string | null {
  const match = value.match(/^@secret:(.+)$/);
  return match ? match[1] : null;
}

/**
 * Result of resolving secrets for Evalanche boot.
 */
export interface SecretsResolution {
  privateKey?: string;
  mnemonic?: string;
  /** Where the credentials came from */
  source: 'openclaw-secrets' | 'env' | 'keystore';
}

/**
 * Attempt to resolve agent credentials from available sources, in priority order:
 *
 * 1. OpenClaw secrets (if openclaw CLI available + secret refs configured)
 * 2. Raw env vars (AGENT_PRIVATE_KEY / AGENT_MNEMONIC)
 * 3. Keystore (default — returns source='keystore' with no keys)
 *
 * Secret refs in env vars are also resolved:
 * AGENT_PRIVATE_KEY=@secret:eva-wallet-key → resolved via openclaw secrets
 */
export async function resolveAgentSecrets(): Promise<SecretsResolution> {
  const rawPrivateKey = process.env.AGENT_PRIVATE_KEY;
  const rawMnemonic = process.env.AGENT_MNEMONIC;

  // Check if either env var is a secret ref
  const privateKeyRef = rawPrivateKey ? parseSecretRef(rawPrivateKey) : null;
  const mnemonicRef = rawMnemonic ? parseSecretRef(rawMnemonic) : null;

  if (privateKeyRef || mnemonicRef) {
    // Has secret refs — must resolve via OpenClaw
    if (await isOpenClawAvailable()) {
      const [resolvedPrivateKey, resolvedMnemonic] = await Promise.all([
        privateKeyRef ? resolveOpenClawSecret(privateKeyRef) : Promise.resolve(null),
        mnemonicRef ? resolveOpenClawSecret(mnemonicRef) : Promise.resolve(null),
      ]);

      if (resolvedPrivateKey || resolvedMnemonic) {
        return {
          privateKey: resolvedPrivateKey ?? undefined,
          mnemonic: resolvedMnemonic ?? undefined,
          source: 'openclaw-secrets',
        };
      }
    }
    // OpenClaw unavailable or secret not found — fall through to keystore
    return { source: 'keystore' };
  }

  // Plain env vars (no secret refs)
  if (rawPrivateKey || rawMnemonic) {
    return {
      privateKey: rawPrivateKey,
      mnemonic: rawMnemonic,
      source: 'env',
    };
  }

  // No env vars — use keystore
  return { source: 'keystore' };
}
