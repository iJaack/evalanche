import { JsonRpcProvider } from 'ethers';
import { IdentityResolver } from './identity/resolver';
import { ReputationReporter } from './reputation/reporter';
import { X402Client } from './x402/client';
import { TransactionBuilder } from './wallet/transaction';
import { createWalletFromPrivateKey, createWalletFromMnemonic } from './wallet/signer';
import type { AgentSigner } from './wallet/signer';
import { getNetworkConfig } from './utils/networks';
import type { NetworkOption } from './utils/networks';
import type { AgentIdentity, IdentityConfig } from './identity/types';
import type { TransactionIntent, CallIntent, TransactionResult } from './wallet/types';
import type { FeedbackSubmission } from './reputation/types';
import type { PayAndFetchOptions, PayAndFetchResult } from './x402/types';
import { EvalancheError, EvalancheErrorCode } from './utils/errors';

/** Configuration for the Evalanche agent */
export interface EvalancheConfig {
  privateKey?: string;
  mnemonic?: string;
  identity?: IdentityConfig;
  network?: NetworkOption;
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

  private identityResolver?: IdentityResolver;
  private reputationReporter: ReputationReporter;
  private x402Client: X402Client;
  private transactionBuilder: TransactionBuilder;

  /**
   * Create a new Evalanche agent.
   * @param config - Agent configuration (private key or mnemonic, network, optional identity)
   */
  constructor(config: EvalancheConfig) {
    const networkConfig = getNetworkConfig(config.network ?? 'avalanche');
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
}
