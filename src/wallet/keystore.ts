import { randomBytes } from 'crypto';
import { Wallet, HDNodeWallet } from 'ethers';
import { readFile, writeFile, mkdir, access, chmod } from 'fs/promises';
import { dirname, join } from 'path';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Options for the agent keystore */
export interface KeystoreOptions {
  /** Directory to store the encrypted keystore file. Defaults to ~/.evalanche/keys */
  dir?: string;
  /** Filename for the keystore. Defaults to 'agent.json' */
  filename?: string;
}

/** Result from initializing a new agent wallet */
export interface KeystoreInitResult {
  /** The agent's C-Chain address */
  address: string;
  /** Path to the encrypted keystore file */
  keystorePath: string;
  /** Whether this was freshly generated (true) or loaded from existing keystore (false) */
  isNew: boolean;
}

/**
 * Non-custodial agent keystore.
 *
 * Generates a wallet, encrypts it with a self-derived password,
 * and persists to disk. No human ever sees or handles the private key.
 *
 * The encryption password is derived from machine-local entropy stored
 * alongside the keystore. This is NOT a password the human sets — the
 * agent manages its own key lifecycle.
 *
 * Uses ethers v6 keystore format (AES-128-CTR + scrypt), same as geth.
 */
export class AgentKeystore {
  private readonly dir: string;
  private readonly filename: string;
  private readonly keystorePath: string;
  private readonly entropyPath: string;

  constructor(options?: KeystoreOptions) {
    this.dir = options?.dir ?? join(process.env.HOME ?? '/tmp', '.evalanche', 'keys');
    this.filename = options?.filename ?? 'agent.json';
    this.keystorePath = join(this.dir, this.filename);
    this.entropyPath = join(this.dir, `.${this.filename}.entropy`);
  }

  /**
   * Initialize the agent wallet — load existing or generate new.
   * Fully autonomous: no human input required.
   *
   * @returns Init result with address, keystore path, and whether it was freshly created
   */
  async init(): Promise<KeystoreInitResult> {
    try {
      // Try loading existing keystore first
      if (await this.exists()) {
        const wallet = await this.load();
        return {
          address: wallet.address,
          keystorePath: this.keystorePath,
          isNew: false,
        };
      }

      // Generate new wallet and persist
      const wallet = HDNodeWallet.createRandom();
      await this.save(wallet);
      return {
        address: wallet.address,
        keystorePath: this.keystorePath,
        isNew: true,
      };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        'Failed to initialize agent keystore',
        EvalancheErrorCode.WALLET_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Load and decrypt the agent wallet from disk.
   * @returns Decrypted ethers HDNodeWallet (with mnemonic) or Wallet
   */
  async load(): Promise<HDNodeWallet | Wallet> {
    try {
      const [keystore, password] = await Promise.all([
        readFile(this.keystorePath, 'utf-8'),
        this.getPassword(),
      ]);
      return await Wallet.fromEncryptedJson(keystore, password);
    } catch (error) {
      throw new EvalancheError(
        `Failed to load keystore from ${this.keystorePath}`,
        EvalancheErrorCode.WALLET_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Export the mnemonic phrase. Use with extreme caution.
   * Intended for backup/migration, not routine use.
   * @returns BIP-39 mnemonic phrase
   */
  async exportMnemonic(): Promise<string> {
    const wallet = await this.load();
    const mnemonic = (wallet as HDNodeWallet).mnemonic;
    if (!mnemonic) {
      throw new EvalancheError(
        'Keystore does not contain a mnemonic (was created from private key)',
        EvalancheErrorCode.WALLET_ERROR,
      );
    }
    return mnemonic.phrase;
  }

  /**
   * Check if a keystore file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await access(this.keystorePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the path to the encrypted keystore file.
   */
  getPath(): string {
    return this.keystorePath;
  }

  // ── Internal ──────────────────────────────────────────────

  /**
   * Encrypt and save a wallet to disk.
   * Also generates and persists the entropy file used for password derivation.
   */
  private async save(wallet: HDNodeWallet | Wallet): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    // Generate machine-local entropy for password derivation
    const entropy = randomBytes(32).toString('hex');
    await writeFile(this.entropyPath, entropy, { mode: 0o600 });
    await chmod(this.entropyPath, 0o600);

    const password = this.derivePassword(entropy);
    const encrypted = await wallet.encrypt(password);
    await writeFile(this.keystorePath, encrypted, { mode: 0o600 });
    await chmod(this.keystorePath, 0o600);
  }

  /**
   * Get the encryption password from the entropy file.
   */
  private async getPassword(): Promise<string> {
    try {
      const entropy = await readFile(this.entropyPath, 'utf-8');
      return this.derivePassword(entropy.trim());
    } catch {
      throw new EvalancheError(
        `Entropy file missing at ${this.entropyPath} — keystore cannot be decrypted`,
        EvalancheErrorCode.WALLET_ERROR,
      );
    }
  }

  /**
   * Derive a password from the entropy.
   * Simple but effective: the entropy IS the password material.
   * The actual protection comes from ethers' scrypt KDF inside the keystore.
   */
  private derivePassword(entropy: string): string {
    return `evalanche:${entropy}`;
  }
}
