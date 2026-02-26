import { JsonRpcProvider, formatEther, parseEther } from 'ethers';
import { IdentityResolver } from './identity/resolver';
import { ReputationReporter } from './reputation/reporter';
import { X402Client } from './x402/client';
import { TransactionBuilder } from './wallet/transaction';
import { createWalletFromPrivateKey, createWalletFromMnemonic, generateWallet } from './wallet/signer';
import type { AgentSigner, GeneratedWallet } from './wallet/signer';
import { AgentKeystore } from './wallet/keystore';
import type { KeystoreOptions, KeystoreInitResult } from './wallet/keystore';
import { getNetworkConfig } from './utils/networks';
import type { NetworkOption } from './utils/networks';
import type { AgentIdentity, IdentityConfig } from './identity/types';
import type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';
import type { FeedbackSubmission } from './reputation/types';
import type { PayAndFetchOptions, PayAndFetchResult } from './x402/types';
import { EvalancheError, EvalancheErrorCode } from './utils/errors';
// Avalanche multi-VM types only (actual imports are lazy to avoid loading
// @avalabs/core-wallets-sdk at construction time — it has heavy native deps)
import type { ChainAlias, TransferResult, MultiChainBalance, StakeInfo, ValidatorInfo, MinStakeAmounts } from './avalanche/types';

/** Configuration for the Evalanche agent */
export interface EvalancheConfig {
  privateKey?: string;
  mnemonic?: string;
  identity?: IdentityConfig;
  network?: NetworkOption;
  /** Enable multi-VM support (X-Chain, P-Chain). Requires mnemonic. */
  multiVM?: boolean;
}

/**
 * Main Evalanche agent class — provides wallet, identity, transactions,
 * reputation, and x402 payment capabilities for AI agents on Avalanche.
 */
export class Evalanche {
  /** The underlying ethers signer instance */
  readonly wallet: AgentSigner;
  /** The JSON-RPC provider connected to the network */
  readonly provider: JsonRpcProvider;
  /** The agent's wallet address */
  readonly address: string;

  private readonly _networkOption: NetworkOption;
  private identityResolver?: IdentityResolver;
  private reputationReporter: ReputationReporter;
  private x402Client: X402Client;
  private transactionBuilder: TransactionBuilder;

  // Multi-VM (v0.2.0) — types are `any` here because actual classes are lazy-loaded
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private avalancheProvider?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private avalancheSigner?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _xChain?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pChain?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _crossChain?: any;
  private readonly _mnemonic?: string;
  private readonly _multiVM: boolean;
  private _multiVMInitialized = false;

  /**
   * Generate a new agent with a fresh wallet — no human input required.
   * Creates a cryptographically random BIP-39 mnemonic, derives keys,
   * and returns a fully initialized Evalanche agent.
   *
   * ⚠️ The returned wallet contains the plaintext mnemonic and private key.
   * For non-custodial autonomous operation, use `Evalanche.boot()` instead —
   * it encrypts and persists the key material automatically.
   *
   * @param options - Optional network, identity, and multiVM config
   * @returns Object with the agent instance and the generated wallet details (mnemonic, privateKey, address)
   */
  static generate(options?: Omit<EvalancheConfig, 'privateKey' | 'mnemonic'>): {
    agent: Evalanche;
    wallet: GeneratedWallet;
  } {
    const generated = generateWallet();
    const agent = new Evalanche({
      ...options,
      mnemonic: generated.mnemonic,
    });
    return { agent, wallet: generated };
  }

  /**
   * Boot an autonomous, non-custodial agent.
   *
   * First call: generates a wallet, encrypts it, persists to disk.
   * Subsequent calls: loads and decrypts the existing keystore.
   *
   * No human ever sees the private key or mnemonic. The agent manages
   * its own key lifecycle with encrypted-at-rest storage.
   *
   * @param options - Network, identity, multiVM, and keystore config
   * @returns Object with the agent instance and keystore init result
   *
   * @example
   * ```ts
   * const { agent, keystore } = await Evalanche.boot({ network: 'fuji' });
   * console.log(agent.address);       // 0x...
   * console.log(keystore.isNew);      // true on first run, false after
   * console.log(keystore.keystorePath); // ~/.evalanche/keys/agent.json
   * ```
   */
  static async boot(options?: Omit<EvalancheConfig, 'privateKey' | 'mnemonic'> & {
    keystore?: KeystoreOptions;
  }): Promise<{
    agent: Evalanche;
    keystore: KeystoreInitResult;
  }> {
    const store = new AgentKeystore(options?.keystore);
    const initResult = await store.init();

    // Load the decrypted wallet to get the mnemonic for multi-VM support
    const wallet = await store.load();
    const mnemonic = 'mnemonic' in wallet && wallet.mnemonic ? wallet.mnemonic.phrase : undefined;

    const agent = new Evalanche({
      ...options,
      // Use mnemonic if available (for multi-VM), otherwise fall back to private key
      ...(mnemonic ? { mnemonic } : { privateKey: wallet.privateKey }),
    });

    return { agent, keystore: initResult };
  }

  /**
   * Create a new Evalanche agent.
   * @param config - Agent configuration (private key or mnemonic, network, optional identity)
   */
  constructor(config: EvalancheConfig) {
    this._networkOption = config.network ?? 'avalanche';
    const networkConfig = getNetworkConfig(this._networkOption);
    this.provider = new JsonRpcProvider(networkConfig.rpcUrl);

    if (config.privateKey) {
      this.wallet = createWalletFromPrivateKey(config.privateKey, this.provider);
    } else if (config.mnemonic) {
      this.wallet = createWalletFromMnemonic(config.mnemonic, this.provider);
    } else {
      throw new EvalancheError(
        'Either privateKey or mnemonic is required',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }

    this.address = this.wallet.address;

    if (config.identity) {
      this.identityResolver = new IdentityResolver(this.provider, config.identity);
    }

    this.reputationReporter = new ReputationReporter(this.wallet);
    this.x402Client = new X402Client(this.wallet);
    this.transactionBuilder = new TransactionBuilder(this.wallet);

    // Store mnemonic for multi-VM lazy init
    this._mnemonic = config.mnemonic;
    this._multiVM = config.multiVM ?? false;
  }

  /**
   * Lazily initialize multi-VM (Avalanche X/P-Chain) support.
   * Uses dynamic imports to avoid loading @avalabs/core-wallets-sdk at construction time.
   */
  private async initMultiVM(): Promise<void> {
    if (this._multiVMInitialized) return;

    if (!this._mnemonic) {
      throw new EvalancheError(
        'Multi-VM requires a mnemonic (not just a private key). Pass mnemonic in EvalancheConfig.',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }

    const networkName = typeof this._networkOption === 'string'
      ? (this._networkOption === 'fuji' ? 'fuji' : 'avalanche')
      : 'avalanche';

    // Dynamic imports to avoid loading heavy native deps at construction time
    const { createAvalancheProvider } = await import('./avalanche/provider');
    const { createAvalancheSigner } = await import('./avalanche/signer');
    const { XChainOperations } = await import('./avalanche/xchain');
    const { PChainOperations } = await import('./avalanche/pchain');
    const { CrossChainTransfer } = await import('./avalanche/crosschain');

    this.avalancheProvider = await createAvalancheProvider(networkName as 'avalanche' | 'fuji');
    this.avalancheSigner = createAvalancheSigner(this._mnemonic, this.avalancheProvider);
    this._xChain = new XChainOperations(this.avalancheSigner, this.avalancheProvider);
    this._pChain = new PChainOperations(this.avalancheSigner, this.avalancheProvider);
    this._crossChain = new CrossChainTransfer(this.avalancheSigner, this.avalancheProvider);
    this._multiVMInitialized = true;
  }

  /**
   * Get X-Chain operations (lazy-inits multi-VM on first call).
   * @returns XChainOperations instance
   */
  async xChain(): Promise<{ getAddress(): string; getBalance(): Promise<bigint>; exportTo(amount: bigint, dest: 'P' | 'C'): Promise<string>; importFrom(source: 'P' | 'C'): Promise<string> }> {
    await this.initMultiVM();
    return this._xChain!;
  }

  /**
   * Get P-Chain operations (lazy-inits multi-VM on first call).
   * @returns PChainOperations instance
   */
  async pChain(): Promise<{ getAddress(): string; getBalance(): Promise<bigint>; exportTo(amount: bigint, dest: 'X' | 'C'): Promise<string>; importFrom(source: 'X' | 'C'): Promise<string>; addDelegator(nodeId: string, amount: bigint, start: bigint, end: bigint, reward?: string): Promise<string>; getStake(): Promise<StakeInfo[]>; getCurrentValidators(limit?: number): Promise<ValidatorInfo[]>; getMinStake(): Promise<MinStakeAmounts> }> {
    await this.initMultiVM();
    return this._pChain!;
  }

  /**
   * Resolve the on-chain identity for this agent.
   * Requires identity config to be set during construction.
   * @returns Resolved agent identity with reputation and trust level
   */
  async resolveIdentity(): Promise<AgentIdentity> {
    if (!this.identityResolver) {
      throw new EvalancheError(
        'Identity config not provided — pass identity in EvalancheConfig to use this method',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    return this.identityResolver.resolve();
  }

  /**
   * Send a simple transaction (value transfer or raw data).
   * @param intent - Transaction intent with to address and human-readable AVAX value
   * @returns Transaction hash and receipt
   */
  async send(intent: TransactionIntent): Promise<TransactionResult> {
    return this.transactionBuilder.send(intent);
  }

  /**
   * Call a contract method (state-changing transaction).
   * @param intent - Contract call intent with ABI, method name, and args
   * @returns Transaction hash and receipt
   */
  async call(intent: CallIntent): Promise<TransactionResult> {
    return this.transactionBuilder.call(intent);
  }

  /**
   * Make an x402 payment-gated HTTP request.
   * Automatically handles 402 Payment Required responses.
   * @param url - URL to fetch
   * @param options - Payment and request options
   * @returns Response with status, headers, body, and optional payment hash
   */
  async payAndFetch(url: string, options: PayAndFetchOptions): Promise<PayAndFetchResult> {
    return this.x402Client.payAndFetch(url, options);
  }

  /**
   * Submit reputation feedback for another agent on-chain.
   * @param feedback - Feedback submission with target agent, task ref, and score
   * @returns Transaction hash
   */
  async submitFeedback(feedback: FeedbackSubmission): Promise<string> {
    return this.reputationReporter.submitFeedback(feedback);
  }

  /**
   * Sign an arbitrary message with the agent's wallet.
   * @param message - Message to sign
   * @returns Hex-encoded signature
   */
  async signMessage(message: string): Promise<string> {
    return this.wallet.signMessage(message);
  }

  // ── Multi-VM Methods (v0.2.0) ─────────────────────────────

  /**
   * Transfer AVAX between chains (C↔X↔P).
   * Handles the full export→wait→import atomic flow.
   * @param from - Source chain
   * @param to - Destination chain
   * @param amount - Amount in AVAX (human-readable, e.g. '25')
   * @returns Export and import transaction IDs
   */
  async transfer(opts: {
    from: ChainAlias;
    to: ChainAlias;
    amount: string;
  }): Promise<TransferResult> {
    await this.initMultiVM();
    const amountNAvax = parseEther(opts.amount) / BigInt(1e9); // AVAX → nAVAX
    return this._crossChain!.transfer(opts.from, opts.to, amountNAvax);
  }

  /**
   * Delegate AVAX to a validator.
   * @param nodeId - Validator node ID
   * @param amount - Amount in AVAX (human-readable)
   * @param durationDays - Delegation duration in days (min 14)
   * @returns Transaction ID
   */
  async delegate(
    nodeId: string,
    amount: string,
    durationDays: number,
  ): Promise<string> {
    const pChain = await this.pChain();
    const amountNAvax = parseEther(amount) / BigInt(1e9);
    const now = BigInt(Math.floor(Date.now() / 1000)) + BigInt(60); // start 1 min from now
    const end = now + BigInt(durationDays * 86400);
    return pChain.addDelegator(nodeId, amountNAvax, now, end);
  }

  /**
   * Get staking info for this agent's P-Chain address.
   * @returns Array of stake info
   */
  async getStake(): Promise<StakeInfo[]> {
    const pChain = await this.pChain();
    return pChain.getStake();
  }

  /**
   * Get current validators on the Primary Network.
   * @param limit - Max validators to return
   * @returns Array of validator info
   */
  async getValidators(limit?: number): Promise<ValidatorInfo[]> {
    const pChain = await this.pChain();
    return pChain.getCurrentValidators(limit);
  }

  /**
   * Get min stake amounts for validators and delegators.
   */
  async getMinStake(): Promise<MinStakeAmounts> {
    const pChain = await this.pChain();
    return pChain.getMinStake();
  }

  /**
   * Get AVAX balance across all chains (C, X, P).
   * @returns Multi-chain balance in AVAX (human-readable)
   */
  async getMultiChainBalance(): Promise<MultiChainBalance> {
    await this.initMultiVM();

    const [cBalanceWei, xBalanceNAvax, pBalanceNAvax] = await Promise.all([
      this.provider.getBalance(this.address),
      this._xChain!.getBalance(),
      this._pChain!.getBalance(),
    ]);

    const cAvax = formatEther(cBalanceWei);
    const xAvax = (Number(xBalanceNAvax) / 1e9).toFixed(9);
    const pAvax = (Number(pBalanceNAvax) / 1e9).toFixed(9);
    const total = (
      parseFloat(cAvax) +
      Number(xBalanceNAvax) / 1e9 +
      Number(pBalanceNAvax) / 1e9
    ).toFixed(9);

    return { C: cAvax, X: xAvax, P: pAvax, total };
  }

  /**
   * Get addresses across all chains.
   * @returns Object with C, X, P addresses
   */
  async getAddresses(): Promise<{ C: string; X: string; P: string }> {
    await this.initMultiVM();
    return {
      C: this.address,
      X: this._xChain!.getAddress(),
      P: this._pChain!.getAddress(),
    };
  }
}
