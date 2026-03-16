import { JsonRpcProvider, formatEther, parseEther } from 'ethers';
import { IdentityResolver } from './identity/resolver';
import { ReputationReporter } from './reputation/reporter';
import { X402Client } from './x402/client';
import { TransactionBuilder } from './wallet/transaction';
import { createWalletFromPrivateKey, createWalletFromMnemonic, generateWallet } from './wallet/signer';
import type { AgentSigner, GeneratedWallet } from './wallet/signer';
import { AgentKeystore } from './wallet/keystore';
import type { KeystoreOptions, KeystoreInitResult } from './wallet/keystore';
import { resolveAgentSecrets } from './secrets';
import { getNetworkConfig, getChainConfigForNetwork } from './utils/networks';
import type { NetworkOption } from './utils/networks';
import type { ChainConfig } from './utils/chains';
import { getAllChains } from './utils/chains';
import type { AgentIdentity, IdentityConfig } from './identity/types';
import type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';
import type { FeedbackSubmission } from './reputation/types';
import type { PayAndFetchOptions, PayAndFetchResult } from './x402/types';
import { EvalancheError, EvalancheErrorCode } from './utils/errors';
import { PolicyEngine } from './economy/policies';
import { simulateTransaction as simulate } from './economy/simulation';
import type { SpendingPolicy, BudgetStatus, PendingTransaction } from './economy/types';
import type { SimulationResult } from './economy/simulation';
import { BridgeClient } from './bridge';
import type { BridgeQuoteParams, BridgeQuote, TransferStatusParams, TransferStatus, LiFiToken, LiFiChain, LiFiTools, LiFiGasPrices, LiFiGasSuggestion, LiFiConnection } from './bridge/lifi';
import type { GasZipParams } from './bridge/gaszip';
import type { DydxClient, PerpMarket } from './perps';
// Avalanche multi-VM types only (actual imports are lazy to avoid loading
// @avalabs/core-wallets-sdk at construction time — it has heavy native deps)
import type { ChainAlias, TransferResult, MultiChainBalance, StakeInfo, ValidatorInfo, MinStakeAmounts } from './avalanche/types';
import type { PlatformCLI as PlatformCLIType } from './avalanche/platform-cli';
import type { InteropIdentityResolver as InteropResolverType } from './interop/identity';
import type { LiquidStakingClient } from './defi/liquid-staking';
import type { VaultClient } from './defi/vaults';

/** Configuration for the Evalanche agent */
export interface EvalancheConfig {
  privateKey?: string;
  mnemonic?: string;
  identity?: IdentityConfig;
  network?: NetworkOption;
  /** Enable multi-VM support (X-Chain, P-Chain). Requires mnemonic. Only applies on Avalanche networks. */
  multiVM?: boolean;
  /** Override the default RPC for the selected chain */
  rpcOverride?: string;
  /** Optional spending policy — enforces per-tx limits, budgets, and allowlists */
  policy?: SpendingPolicy;
}

/**
 * Main Evalanche agent class — provides wallet, identity, transactions,
 * reputation, x402 payment, and cross-chain bridging capabilities for
 * AI agents on any EVM chain.
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
  private _bridgeClient?: BridgeClient;
  private _dydxClient?: DydxClient;
  private _policyEngine?: PolicyEngine;
  private readonly _chainId: number;

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
  private _platformCLI?: PlatformCLIType;
  private _interopResolver?: InteropResolverType;
  private _defiStaking?: LiquidStakingClient;
  private _defiVaults?: VaultClient;
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
   * const { agent, keystore } = await Evalanche.boot({ network: 'base' });
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
    /** Where the credentials came from: 'openclaw-secrets' | 'env' | 'keystore' */
    secretsSource: 'openclaw-secrets' | 'env' | 'keystore';
  }> {
    // Resolve credentials: OpenClaw secrets (preferred) → env vars → keystore
    const resolved = await resolveAgentSecrets();

    if (resolved.source !== 'keystore') {
      // Credentials resolved externally — build a dummy keystoreInitResult for API compat
      const agent = new Evalanche({
        ...options,
        ...(resolved.mnemonic
          ? { mnemonic: resolved.mnemonic }
          : { privateKey: resolved.privateKey }),
      });
      const keystoreResult: KeystoreInitResult = {
        address: agent.address,
        keystorePath: '',
        isNew: false,
      };
      return { agent, keystore: keystoreResult, secretsSource: resolved.source };
    }

    // Default: encrypted keystore flow
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

    return { agent, keystore: initResult, secretsSource: 'keystore' };
  }

  /**
   * Get all supported chains.
   * @param includeTestnets - Whether to include testnets (default: true)
   * @returns Array of supported chain configs
   */
  static getSupportedChains(includeTestnets = true): ChainConfig[] {
    return getAllChains(includeTestnets);
  }

  /**
   * Create a new Evalanche agent.
   * @param config - Agent configuration (private key or mnemonic, network, optional identity)
   */
  constructor(config: EvalancheConfig) {
    this._networkOption = config.network ?? 'avalanche';
    const networkConfig = getNetworkConfig(this._networkOption);
    const rpcUrl = config.rpcOverride ?? networkConfig.rpcUrl;
    this.provider = new JsonRpcProvider(rpcUrl);
    this._chainId = networkConfig.chainId;

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

    // Spending policy (optional)
    if (config.policy) {
      this._policyEngine = new PolicyEngine(config.policy);
    }

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

    // Multi-VM only works on Avalanche networks
    const networkName = typeof this._networkOption === 'string'
      ? (this._networkOption === 'fuji' ? 'fuji' : 'avalanche')
      : 'avalanche';

    if (typeof this._networkOption === 'string' && this._networkOption !== 'avalanche' && this._networkOption !== 'fuji') {
      throw new EvalancheError(
        `Multi-VM (X/P-Chain) is only supported on Avalanche networks, not '${this._networkOption}'`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }

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
   * If a spending policy is set, the transaction is checked (and optionally simulated) before sending.
   * @param intent - Transaction intent with to address and human-readable value
   * @returns Transaction hash and receipt
   */
  async send(intent: TransactionIntent): Promise<TransactionResult> {
    await this._enforcePolicy(intent);
    const result = await this.transactionBuilder.send(intent);
    this._recordSpend(intent.to, intent.value ? parseEther(intent.value).toString() : '0', result.hash);
    return result;
  }

  /**
   * Call a contract method (state-changing transaction).
   * If a spending policy is set, the transaction is checked before sending.
   * @param intent - Contract call intent with ABI, method name, and args
   * @returns Transaction hash and receipt
   */
  async call(intent: CallIntent): Promise<TransactionResult> {
    await this._enforcePolicy({
      to: intent.contract,
      value: intent.value ? parseEther(intent.value).toString() : undefined,
    });
    const result = await this.transactionBuilder.call(intent);
    this._recordSpend(intent.contract, intent.value ? parseEther(intent.value).toString() : '0', result.hash);
    return result;
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

  // ── Policy & Simulation (v1.0.0) ─────────────────────────

  /**
   * Get the current spending policy, or null if none is set.
   */
  getPolicy(): SpendingPolicy | null {
    return this._policyEngine?.policy ?? null;
  }

  /**
   * Set or replace the spending policy. Pass null to remove.
   * Spend history is preserved when replacing policies.
   */
  setPolicy(policy: SpendingPolicy | null): void {
    if (policy) {
      if (this._policyEngine) {
        this._policyEngine.updatePolicy(policy);
      } else {
        this._policyEngine = new PolicyEngine(policy);
      }
    } else {
      this._policyEngine = undefined;
    }
  }

  /**
   * Get the current budget status (remaining hourly/daily budget, tx counts).
   * Returns null if no policy is set.
   */
  getBudgetStatus(): BudgetStatus | null {
    return this._policyEngine?.getBudgetStatus() ?? null;
  }

  /**
   * Simulate a transaction without broadcasting it.
   * Runs eth_call to detect reverts and estimate gas.
   * @param intent - Transaction to simulate
   * @returns Simulation result with success/failure, gas estimate, and revert reason
   */
  async simulateTransaction(intent: TransactionIntent): Promise<SimulationResult> {
    const pending: PendingTransaction = {
      to: intent.to,
      value: intent.value ? parseEther(intent.value).toString() : undefined,
      data: intent.data,
      chainId: this._chainId,
      gasLimit: intent.gasLimit,
    };
    return simulate(this.provider, pending);
  }

  /**
   * Enforce the spending policy on a transaction intent.
   * If simulateBeforeSend is enabled, also runs a simulation first.
   * @internal
   */
  private async _enforcePolicy(intent: { to: string; value?: string; data?: string; gasLimit?: bigint }): Promise<void> {
    if (!this._policyEngine) return;

    const pending: PendingTransaction = {
      to: intent.to,
      value: intent.value ?? '0',
      data: intent.data,
      chainId: this._chainId,
      gasLimit: intent.gasLimit,
    };

    // Optional pre-send simulation
    if (this._policyEngine.policy.simulateBeforeSend) {
      const simResult = await simulate(this.provider, pending);
      if (!simResult.success) {
        throw new EvalancheError(
          `Transaction simulation reverted: ${simResult.revertReason ?? 'unknown reason'}`,
          EvalancheErrorCode.SIMULATION_FAILED,
        );
      }
    }

    // Enforce spending limits / allowlists
    this._policyEngine.enforce(pending);
  }

  /**
   * Record a spend after a transaction is confirmed.
   * @internal
   */
  private _recordSpend(to: string, amount: string, txHash: string): void {
    if (!this._policyEngine) return;
    this._policyEngine.recordSpend({
      txHash,
      amount,
      to,
      chainId: this._chainId,
      timestamp: Date.now(),
    });
  }

  // ── Bridge Methods (v0.4.0) ─────────────────────────────

  /** Get or create the bridge client (lazy-initialized) */
  private getBridgeClient(): BridgeClient {
    if (!this._bridgeClient) {
      this._bridgeClient = new BridgeClient(this.wallet);
    }
    return this._bridgeClient;
  }

  /**
   * Get a bridge quote for a cross-chain transfer (without executing).
   * @param params - Bridge quote parameters
   * @returns Best available bridge quote
   */
  async getBridgeQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    return this.getBridgeClient().bridge(params);
  }

  /**
   * Get multiple bridge route options from Li.Fi.
   * @param params - Bridge quote parameters
   * @returns Array of available bridge quotes sorted by recommendation
   */
  async getBridgeRoutes(params: BridgeQuoteParams): Promise<BridgeQuote[]> {
    return this.getBridgeClient().getBridgeRoutes(params);
  }

  /**
   * Bridge tokens cross-chain via Li.Fi. Gets a quote and executes it.
   * @param params - Bridge quote parameters
   * @returns Transaction hash and status
   */
  async bridgeTokens(params: BridgeQuoteParams): Promise<{ txHash: string; status: string }> {
    const client = this.getBridgeClient();
    const quote = await client.bridge(params);
    return client.executeBridge(quote);
  }

  async checkBridgeStatus(params: TransferStatusParams): Promise<TransferStatus> {
    return this.getBridgeClient().checkTransferStatus(params);
  }

  async getSwapQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    return this.getBridgeClient().getSwapQuote(params);
  }

  async swap(params: BridgeQuoteParams): Promise<{ txHash: string; status: string }> {
    const client = this.getBridgeClient();
    const quote = await client.getSwapQuote(params);
    return client.executeSwap(quote);
  }

  async getTokens(chainIds: number[]): Promise<Record<string, LiFiToken[]>> {
    return this.getBridgeClient().getTokens(chainIds);
  }

  async getToken(chainId: number, address: string): Promise<LiFiToken> {
    return this.getBridgeClient().getToken(chainId, address);
  }

  async getLiFiChains(chainTypes?: string[]): Promise<LiFiChain[]> {
    return this.getBridgeClient().getChains(chainTypes);
  }

  async getLiFiTools(): Promise<LiFiTools> {
    return this.getBridgeClient().getTools();
  }

  async getGasPrices(): Promise<LiFiGasPrices> {
    return this.getBridgeClient().getGasPrices();
  }

  async getGasSuggestion(chainId: number): Promise<LiFiGasSuggestion> {
    return this.getBridgeClient().getGasSuggestion(chainId);
  }

  async getLiFiConnections(params: { fromChainId: number; toChainId: number; fromToken?: string; toToken?: string }): Promise<LiFiConnection[]> {
    return this.getBridgeClient().getConnections(params);
  }

  /**
   * Fund an address with gas on a destination chain via Gas.zip.
   * @param params - Gas funding parameters
   * @returns Transaction hash
   */
  async fundDestinationGas(params: GasZipParams): Promise<{ txHash: string }> {
    return this.getBridgeClient().fundGas(params, this.wallet);
  }

  /**
   * Get or create the dYdX perpetuals client (lazy-initialized).
   *
   * Requires mnemonic because dYdX derives Cosmos keys from BIP-39.
   */
  async dydx(): Promise<DydxClient> {
    if (!this._mnemonic) {
      throw new EvalancheError(
        'dYdX requires a mnemonic (not just a private key). Pass mnemonic in EvalancheConfig.',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }

    if (!this._dydxClient) {
      const { DydxClient } = await import('./perps/dydx/client');
      this._dydxClient = new DydxClient(this._mnemonic);
      await this._dydxClient.connect();
    }

    return this._dydxClient;
  }

  /**
   * Get or create the interop identity resolver (lazy-initialized).
   * Resolves full ERC-8004 registration files, service endpoints,
   * wallet addresses, and endpoint bindings.
   */
  interop(): InteropResolverType {
    if (!this._interopResolver) {
      // Lazy import to avoid loading interop module at construction time
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { InteropIdentityResolver } = require('./interop/identity') as typeof import('./interop/identity');
      this._interopResolver = new InteropIdentityResolver(this.provider);
    }
    return this._interopResolver;
  }

  // ── DeFi Module (v1.2.0) ─────────────────────────────────

  /**
   * Get the DeFi module with lazy-initialized staking and vault clients.
   * @returns Object with staking and vaults sub-clients
   */
  defi(): { staking: LiquidStakingClient; vaults: VaultClient } {
    if (!this._defiStaking) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LiquidStakingClient: LSC } = require('./defi/liquid-staking') as typeof import('./defi/liquid-staking');
      this._defiStaking = new LSC(this.wallet);
    }
    if (!this._defiVaults) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { VaultClient: VC } = require('./defi/vaults') as typeof import('./defi/vaults');
      const networkName = typeof this._networkOption === 'string' ? this._networkOption : 'ethereum';
      this._defiVaults = new VC(this.wallet, networkName);
    }
    return { staking: this._defiStaking, vaults: this._defiVaults };
  }

  /**
   * Find a perpetual market ticker across connected perp venues.
   */
  async findPerpMarket(ticker: string): Promise<{ venue: string; market: PerpMarket } | null> {
    try {
      const dydx = await this.dydx();
      const markets = await dydx.getMarkets();
      const match = markets.find((market) => market.ticker.toUpperCase() === ticker.toUpperCase());
      if (match) {
        return { venue: dydx.name, market: match };
      }
      return null;
    } catch (cause) {
      throw new EvalancheError(
        `Failed to find perpetual market: ${ticker}`,
        EvalancheErrorCode.PERPS_ERROR,
        cause instanceof Error ? cause : undefined,
      );
    }
  }

  /**
   * Get info about the current chain from the registry.
   * @returns Chain config if available, otherwise basic network info
   */
  getChainInfo(): ChainConfig | { id: number; name: string } {
    const chainConfig = getChainConfigForNetwork(this._networkOption);
    if (chainConfig) return chainConfig;

    const networkConfig = getNetworkConfig(this._networkOption);
    return {
      id: networkConfig.chainId,
      name: networkConfig.name,
    };
  }

  /**
   * Create a new Evalanche instance on a different network.
   * Preserves the same keys but connects to a different chain.
   * @param network - Target network
   * @returns New Evalanche instance connected to the target network
   */
  switchNetwork(network: NetworkOption): Evalanche {
    return new Evalanche({
      ...(this._mnemonic ? { mnemonic: this._mnemonic } : { privateKey: this.wallet.privateKey }),
      network,
      multiVM: this._multiVM,
    });
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
   * Get a PlatformCLI instance for advanced P-Chain operations
   * (subnets, L1 validators, enhanced staking with BLS keys, node info).
   *
   * Requires the `platform-cli` Go binary to be installed:
   *   go install github.com/ava-labs/platform-cli@latest
   *
   * The CLI instance is lazy-initialized and cached.
   *
   * @param opts - Optional overrides for binary path, key name, or RPC URL
   * @returns PlatformCLI instance
   */
  async platformCLI(opts?: {
    binaryPath?: string;
    keyName?: string;
    rpcUrl?: string;
  }): Promise<PlatformCLIType> {
    if (!this._platformCLI) {
      const { PlatformCLI } = await import('./avalanche/platform-cli');
      const network = typeof this._networkOption === 'string'
        ? (this._networkOption === 'fuji' ? 'fuji' : 'mainnet')
        : 'mainnet';
      this._platformCLI = new PlatformCLI({
        network,
        privateKey: this.wallet.privateKey,
        ...opts,
      });
    }
    return this._platformCLI;
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
