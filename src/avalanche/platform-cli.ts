import { execFile } from 'child_process';
import { promisify } from 'util';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

const execFileAsync = promisify(execFile);

/** Result from a platform-cli command */
export interface PlatformCLIResult {
  stdout: string;
  stderr: string;
  txId?: string;
}

/** Subnet creation result */
export interface SubnetCreateResult {
  txId: string;
  subnetId: string;
}

/** L1 validator registration result */
export interface L1RegisterResult {
  txId: string;
  validationId?: string;
}

/** Node info result */
export interface NodeInfoResult {
  nodeId: string;
  blsPublicKey: string;
  blsPop: string;
}

/** Add validator parameters */
export interface AddValidatorParams {
  nodeId: string;
  stakeAvax: number;
  durationHours?: number;
  delegationFee?: number;
  blsPublicKey?: string;
  blsPop?: string;
  nodeEndpoint?: string;
  rewardAddress?: string;
  startTime?: string;
}

/** Delegate parameters */
export interface DelegateParams {
  nodeId: string;
  stakeAvax: number;
  durationHours?: number;
  rewardAddress?: string;
  startTime?: string;
}

/** Subnet convert to L1 parameters */
export interface ConvertToL1Params {
  subnetId: string;
  chainId: string;
  validators?: string;
  managerAddress?: string;
  validatorNodeIds?: string;
  validatorBlsPublicKeys?: string;
  validatorBlsPops?: string;
  validatorWeights?: string;
  validatorBalance?: number;
  mockValidator?: boolean;
}

/** Transfer parameters */
export interface PChainTransferParams {
  to: string;
  amountAvax?: number;
  amountNAvax?: bigint;
}

/** Cross-chain transfer parameters */
export interface CrossChainTransferParams {
  amountAvax: number;
}

/**
 * Platform CLI wrapper for advanced P-Chain operations.
 *
 * Wraps the `platform-cli` Go binary (ava-labs/platform-cli) as an optional
 * subprocess. Provides subnet management, L1 validator ops, and enhanced
 * staking and L1 lifecycle features exposed by Avalanche CLI.
 *
 * Falls back gracefully if the binary is not installed.
 */
export class PlatformCLI {
  private readonly binaryPath: string;
  private readonly network: 'fuji' | 'mainnet';
  private readonly keyName?: string;
  private readonly privateKey?: string;
  private readonly rpcUrl?: string;
  private _available?: boolean;

  constructor(opts: {
    binaryPath?: string;
    network?: 'fuji' | 'mainnet';
    keyName?: string;
    privateKey?: string;
    rpcUrl?: string;
  } = {}) {
    this.binaryPath = opts.binaryPath ?? 'platform-cli';
    this.network = opts.network ?? 'mainnet';
    this.keyName = opts.keyName;
    this.privateKey = opts.privateKey;
    this.rpcUrl = opts.rpcUrl;
  }

  /**
   * Check if the platform-cli binary is available.
   * Caches the result after first check.
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== undefined) return this._available;

    try {
      await execFileAsync(this.binaryPath, ['version'], { timeout: 5_000 });
      this._available = true;
    } catch {
      // Try common install locations
      for (const path of [
        `${process.env.HOME}/go/bin/platform-cli`,
        '/usr/local/bin/platform-cli',
        '/opt/homebrew/bin/platform-cli',
      ]) {
        try {
          await execFileAsync(path, ['version'], { timeout: 5_000 });
          (this as unknown as { binaryPath: string }).binaryPath = path;
          this._available = true;
          return true;
        } catch {
          continue;
        }
      }
      this._available = false;
    }
    return this._available;
  }

  /**
   * Ensure the CLI is available, throw if not.
   */
  private async ensureAvailable(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new EvalancheError(
        'platform-cli binary not found. Install with: go install github.com/ava-labs/platform-cli@latest',
        EvalancheErrorCode.PLATFORM_CLI_NOT_FOUND,
      );
    }
  }

  /**
   * Build base arguments with network and auth flags.
   */
  private baseArgs(): string[] {
    const args: string[] = ['--network', this.network];
    if (this.keyName) {
      args.push('--key-name', this.keyName);
    }
    if (this.rpcUrl) {
      args.push('--rpc-url', this.rpcUrl);
    }
    return args;
  }

  /**
   * Build environment variables for the subprocess.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.privateKey) {
      env.AVALANCHE_PRIVATE_KEY = this.privateKey;
    }
    return env;
  }

  /**
   * Execute a platform-cli command.
   */
  private async exec(args: string[], timeoutMs = 120_000): Promise<PlatformCLIResult> {
    await this.ensureAvailable();

    const fullArgs = [...args, ...this.baseArgs()];

    try {
      const { stdout, stderr } = await execFileAsync(
        this.binaryPath,
        fullArgs,
        {
          timeout: timeoutMs,
          env: this.buildEnv(),
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      // Try to extract txId from output
      const txIdMatch = stdout.match(/(?:tx[_ ]?id|transaction[_ ]?id|txID)[:\s]+([A-Za-z0-9]{40,})/i)
        || stdout.match(/^([A-Za-z0-9]{40,})$/m);
      const txId = txIdMatch ? txIdMatch[1] : undefined;

      return { stdout: stdout.trim(), stderr: stderr.trim(), txId };
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new EvalancheError(
        `platform-cli command failed: ${err.stderr || err.message || String(error)}`,
        EvalancheErrorCode.PLATFORM_CLI_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ── Wallet Operations ─────────────────────────────

  /**
   * Get P-Chain wallet address.
   */
  async getAddress(): Promise<string> {
    const result = await this.exec(['wallet', 'address']);
    const match = result.stdout.match(/(P-[a-zA-Z0-9]+)/);
    if (!match) {
      throw new EvalancheError(
        `Failed to parse address from output: ${result.stdout}`,
        EvalancheErrorCode.PLATFORM_CLI_ERROR,
      );
    }
    return match[1];
  }

  /**
   * Get P-Chain balance in nAVAX.
   */
  async getBalance(): Promise<{ balanceNAvax: bigint; balanceAvax: string }> {
    const result = await this.exec(['wallet', 'balance']);
    // Parse output like "Balance: 100.5 AVAX (100500000000 nAVAX)"
    const avaxMatch = result.stdout.match(/([\d.]+)\s*AVAX/i);
    const navaxMatch = result.stdout.match(/(\d+)\s*nAVAX/i);

    const balanceAvax = avaxMatch ? avaxMatch[1] : '0';
    const balanceNAvax = navaxMatch ? BigInt(navaxMatch[1]) : BigInt(0);

    return { balanceNAvax, balanceAvax };
  }

  // ── Key Management ─────────────────────────────

  /**
   * Import a private key into the platform-cli keystore.
   * @param name - Key name
   * @param privateKey - CB58 or hex private key (if not provided, uses env var)
   * @param encrypt - Whether to encrypt the key (default: false for agent use)
   */
  async importKey(name: string, privateKey?: string, encrypt = false): Promise<void> {
    const args = ['keys', 'import', '--name', name];
    if (privateKey) {
      args.push('--private-key', privateKey);
    }
    if (!encrypt) {
      args.push('--encrypt=false');
    }
    await this.exec(args);
  }

  /**
   * List all keys in the platform-cli keystore.
   */
  async listKeys(): Promise<string> {
    const result = await this.exec(['keys', 'list', '--show-addresses']);
    return result.stdout;
  }

  // ── Transfer Operations ─────────────────────────────

  /**
   * Send AVAX on P-Chain (P→P transfer).
   */
  async sendOnPChain(params: PChainTransferParams): Promise<PlatformCLIResult> {
    const args = ['transfer', 'send', '--to', params.to];
    if (params.amountAvax !== undefined) {
      args.push('--amount', String(params.amountAvax));
    } else if (params.amountNAvax !== undefined) {
      args.push('--amount-navax', String(params.amountNAvax));
    }
    return this.exec(args);
  }

  /**
   * Transfer AVAX from P-Chain to C-Chain.
   */
  async transferPtoC(params: CrossChainTransferParams): Promise<PlatformCLIResult> {
    return this.exec(['transfer', 'p-to-c', '--amount', String(params.amountAvax)]);
  }

  /**
   * Transfer AVAX from C-Chain to P-Chain.
   */
  async transferCtoP(params: CrossChainTransferParams): Promise<PlatformCLIResult> {
    return this.exec(['transfer', 'c-to-p', '--amount', String(params.amountAvax)]);
  }

  // ── Staking Operations ─────────────────────────────

  /**
   * Add a validator to the Primary Network.
   * Enhanced over AvalancheJS: supports BLS keys, node endpoint auto-discovery.
   */
  async addValidator(params: AddValidatorParams): Promise<PlatformCLIResult> {
    const args = [
      'validator', 'add',
      '--node-id', params.nodeId,
      '--stake', String(params.stakeAvax),
    ];
    if (params.durationHours) args.push('--duration', `${params.durationHours}h`);
    if (params.delegationFee !== undefined) args.push('--delegation-fee', String(params.delegationFee));
    if (params.blsPublicKey) args.push('--bls-public-key', params.blsPublicKey);
    if (params.blsPop) args.push('--bls-pop', params.blsPop);
    if (params.nodeEndpoint) args.push('--node-endpoint', params.nodeEndpoint);
    if (params.rewardAddress) args.push('--reward-address', params.rewardAddress);
    if (params.startTime) args.push('--start', params.startTime);
    return this.exec(args);
  }

  /**
   * Delegate stake to a validator.
   */
  async delegateStake(params: DelegateParams): Promise<PlatformCLIResult> {
    const args = [
      'validator', 'delegate',
      '--node-id', params.nodeId,
      '--stake', String(params.stakeAvax),
    ];
    if (params.durationHours) args.push('--duration', `${params.durationHours}h`);
    if (params.rewardAddress) args.push('--reward-address', params.rewardAddress);
    if (params.startTime) args.push('--start', params.startTime);
    return this.exec(args);
  }

  // ── Subnet Operations ─────────────────────────────

  /**
   * Create a new subnet.
   * @returns Transaction ID and subnet ID
   */
  async createSubnet(): Promise<SubnetCreateResult> {
    const result = await this.exec(['subnet', 'create']);
    // Parse subnet ID and tx ID from output
    const subnetMatch = result.stdout.match(/(?:subnet[_ ]?id)[:\s]+([A-Za-z0-9]+)/i);
    const txMatch = result.stdout.match(/(?:tx[_ ]?id|transaction)[:\s]+([A-Za-z0-9]+)/i);

    return {
      txId: txMatch ? txMatch[1] : result.txId ?? result.stdout,
      subnetId: subnetMatch ? subnetMatch[1] : '',
    };
  }

  /**
   * Transfer subnet ownership.
   */
  async transferSubnetOwnership(subnetId: string, newOwner: string): Promise<PlatformCLIResult> {
    return this.exec([
      'subnet', 'transfer-ownership',
      '--subnet-id', subnetId,
      '--new-owner', newOwner,
    ]);
  }

  /**
   * Convert a subnet to an L1 blockchain.
   */
  async convertSubnetToL1(params: ConvertToL1Params): Promise<PlatformCLIResult> {
    const args = [
      'subnet', 'convert-l1',
      '--subnet-id', params.subnetId,
      '--chain-id', params.chainId,
    ];
    if (params.validators) args.push('--validators', params.validators);
    if (params.managerAddress) args.push('--manager', params.managerAddress);
    if (params.validatorNodeIds) args.push('--validator-node-ids', params.validatorNodeIds);
    if (params.validatorBlsPublicKeys) args.push('--validator-bls-public-keys', params.validatorBlsPublicKeys);
    if (params.validatorBlsPops) args.push('--validator-bls-pops', params.validatorBlsPops);
    if (params.validatorWeights) args.push('--validator-weights', params.validatorWeights);
    if (params.validatorBalance !== undefined) args.push('--validator-balance', String(params.validatorBalance));
    if (params.mockValidator) args.push('--mock-validator');
    return this.exec(args);
  }

  // ── L1 Validator Operations ─────────────────────────────

  /**
   * Register a new L1 validator.
   */
  async registerL1Validator(
    balanceAvax: number,
    pop: string,
    message: string,
  ): Promise<L1RegisterResult> {
    const result = await this.exec([
      'l1', 'register-validator',
      '--balance', String(balanceAvax),
      '--pop', pop,
      '--message', message,
    ]);

    const validationMatch = result.stdout.match(/(?:validation[_ ]?id)[:\s]+([A-Za-z0-9]+)/i);
    return {
      txId: result.txId ?? result.stdout,
      validationId: validationMatch ? validationMatch[1] : undefined,
    };
  }

  /**
   * Set weight for an L1 validator.
   */
  async setL1ValidatorWeight(message: string): Promise<PlatformCLIResult> {
    return this.exec(['l1', 'set-weight', '--message', message]);
  }

  /**
   * Add balance to an L1 validator.
   */
  async addL1ValidatorBalance(validationId: string, balanceAvax: number): Promise<PlatformCLIResult> {
    return this.exec([
      'l1', 'add-balance',
      '--validation-id', validationId,
      '--balance', String(balanceAvax),
    ]);
  }

  /**
   * Disable an L1 validator.
   */
  async disableL1Validator(validationId: string): Promise<PlatformCLIResult> {
    return this.exec(['l1', 'disable-validator', '--validation-id', validationId]);
  }

  // ── Chain Operations ─────────────────────────────

  /**
   * Create a new blockchain on a subnet.
   */
  async createChain(subnetId: string, genesis: string, name: string): Promise<PlatformCLIResult> {
    return this.exec([
      'chain', 'create',
      '--subnet-id', subnetId,
      '--genesis', genesis,
      '--name', name,
    ]);
  }

  // ── Node Info ─────────────────────────────

  /**
   * Get node info (NodeID + BLS keys) from a running avalanchego node.
   */
  async getNodeInfo(ip: string): Promise<NodeInfoResult> {
    const result = await this.exec(['node', 'info', '--ip', ip]);

    const nodeIdMatch = result.stdout.match(/(?:node[_ ]?id)[:\s]+(NodeID-[A-Za-z0-9]+)/i);
    const blsKeyMatch = result.stdout.match(/(?:bls[_ ]?public[_ ]?key)[:\s]+([0-9a-fA-F]+)/i);
    const blsPopMatch = result.stdout.match(/(?:bls[_ ]?(?:proof[_ ]?of[_ ]?possession|pop))[:\s]+([0-9a-fA-F]+)/i);

    if (!nodeIdMatch) {
      throw new EvalancheError(
        `Failed to parse node info from output: ${result.stdout}`,
        EvalancheErrorCode.PLATFORM_CLI_ERROR,
      );
    }

    return {
      nodeId: nodeIdMatch[1],
      blsPublicKey: blsKeyMatch ? blsKeyMatch[1] : '',
      blsPop: blsPopMatch ? blsPopMatch[1] : '',
    };
  }

  /**
   * Get the CLI version.
   */
  async getVersion(): Promise<string> {
    const result = await this.exec(['version']);
    return result.stdout;
  }
}
