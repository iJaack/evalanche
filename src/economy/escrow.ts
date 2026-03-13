import { Contract, ContractFactory, keccak256, toUtf8Bytes, formatEther } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscrowStatus = 'active' | 'completed' | 'refunded' | 'disputed' | 'resolved';

export interface EscrowInfo {
  jobId: string;
  client: string;
  agent: string;
  /** Amount in wei */
  amount: string;
  /** Deadline as unix timestamp (seconds) */
  deadline: number;
  status: EscrowStatus;
}

export interface EscrowDepositResult {
  txHash: string;
  jobIdHash: string;
  amount: string;
}

export interface EscrowTxResult {
  txHash: string;
}

// ---------------------------------------------------------------------------
// ABI (matches contracts/AgentEscrow.sol)
// ---------------------------------------------------------------------------

const ESCROW_ABI = [
  'constructor(uint256 _defaultTimeout)',
  'function createJob(bytes32 jobId, address agent, uint256 timeout) external payable',
  'function completeJob(bytes32 jobId) external',
  'function refund(bytes32 jobId) external',
  'function disputeJob(bytes32 jobId) external',
  'function resolveDispute(bytes32 jobId, uint256 clientShare) external',
  'function getEscrow(bytes32 jobId) external view returns (address client, address agent, uint256 amount, uint256 deadline, uint8 status)',
  'function owner() external view returns (address)',
  'function defaultTimeout() external view returns (uint256)',
  'event JobCreated(bytes32 indexed jobId, address indexed client, address indexed agent, uint256 amount, uint256 deadline)',
  'event JobCompleted(bytes32 indexed jobId, uint256 amount)',
  'event JobRefunded(bytes32 indexed jobId, uint256 amount)',
  'event JobDisputed(bytes32 indexed jobId, address disputedBy)',
  'event DisputeResolved(bytes32 indexed jobId, uint256 clientShare, uint256 agentShare)',
];

// Compiled bytecode of AgentEscrow.sol (solc 0.8.19, optimized)
// This is a placeholder — in production, compile with: solc --optimize --bin contracts/AgentEscrow.sol
// For now, deployment requires pre-compiled bytecode or using a framework like Hardhat/Foundry.
const ESCROW_BYTECODE = '0x';  // Set after compilation

const STATUS_MAP: EscrowStatus[] = ['active', 'completed', 'refunded', 'disputed', 'resolved'];

// Default timeout: 7 days in seconds
const DEFAULT_TIMEOUT = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// EscrowClient
// ---------------------------------------------------------------------------

/**
 * Client for interacting with the AgentEscrow smart contract.
 *
 * Handles ETH deposits, releases, refunds, and disputes for agent-to-agent jobs.
 *
 * Usage:
 * ```ts
 * const escrow = new EscrowClient(wallet, '0xContractAddress');
 * await escrow.deposit('job_123', '0xAgentAddress', '0.5');
 * await escrow.complete('job_123');
 * ```
 */
export class EscrowClient {
  private readonly _wallet: AgentSigner;
  private readonly _contractAddress: string;
  private readonly _contract: Contract;

  constructor(wallet: AgentSigner, contractAddress: string) {
    this._wallet = wallet;
    this._contractAddress = contractAddress;
    this._contract = new Contract(contractAddress, ESCROW_ABI, wallet);
  }

  /** The escrow contract address */
  get address(): string {
    return this._contractAddress;
  }

  /**
   * Deploy a new AgentEscrow contract.
   * @param wallet - Signer to deploy with (becomes contract owner)
   * @param timeout - Default timeout in seconds (default: 7 days)
   * @returns A new EscrowClient connected to the deployed contract
   */
  static async deploy(wallet: AgentSigner, timeout: number = DEFAULT_TIMEOUT): Promise<EscrowClient> {
    try {
      const factory = new ContractFactory(ESCROW_ABI, ESCROW_BYTECODE, wallet);
      const contract = await factory.deploy(timeout);
      await contract.waitForDeployment();
      const address = await contract.getAddress();
      return new EscrowClient(wallet, address);
    } catch (error) {
      throw new EvalancheError(
        `Escrow deployment failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Convert a string job ID to a bytes32 hash for the contract.
   */
  static hashJobId(jobId: string): string {
    return keccak256(toUtf8Bytes(jobId));
  }

  /**
   * Deposit ETH into escrow for a job.
   * @param jobId - Marketplace job ID (will be hashed to bytes32)
   * @param agentAddress - Service provider's wallet address
   * @param amountEth - Amount in ETH (human-readable, e.g. "0.5")
   * @param timeoutSeconds - Custom timeout (0 = use contract default)
   */
  async deposit(jobId: string, agentAddress: string, amountEth: string, timeoutSeconds: number = 0): Promise<EscrowDepositResult> {
    const jobIdHash = EscrowClient.hashJobId(jobId);
    try {
      const { parseEther } = await import('ethers');
      const tx = await this._contract.createJob(
        jobIdHash,
        agentAddress,
        timeoutSeconds,
        { value: parseEther(amountEth) },
      );
      const receipt = await tx.wait();
      return {
        txHash: receipt.hash,
        jobIdHash,
        amount: amountEth,
      };
    } catch (error) {
      throw new EvalancheError(
        `Escrow deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Release escrowed funds to the agent (called by client when satisfied).
   * @param jobId - Marketplace job ID
   */
  async complete(jobId: string): Promise<EscrowTxResult> {
    const jobIdHash = EscrowClient.hashJobId(jobId);
    try {
      const tx = await this._contract.completeJob(jobIdHash);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch (error) {
      throw new EvalancheError(
        `Escrow completion failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Refund client after the deadline has passed.
   * @param jobId - Marketplace job ID
   */
  async refund(jobId: string): Promise<EscrowTxResult> {
    const jobIdHash = EscrowClient.hashJobId(jobId);
    try {
      const tx = await this._contract.refund(jobIdHash);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch (error) {
      throw new EvalancheError(
        `Escrow refund failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Mark a job as disputed (locks funds until resolution).
   * @param jobId - Marketplace job ID
   */
  async dispute(jobId: string): Promise<EscrowTxResult> {
    const jobIdHash = EscrowClient.hashJobId(jobId);
    try {
      const tx = await this._contract.disputeJob(jobIdHash);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch (error) {
      throw new EvalancheError(
        `Escrow dispute failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Read the current escrow state for a job.
   * @param jobId - Marketplace job ID
   */
  async getEscrow(jobId: string): Promise<EscrowInfo> {
    const jobIdHash = EscrowClient.hashJobId(jobId);
    try {
      const [client, agent, amount, deadline, status] = await this._contract.getEscrow(jobIdHash);
      return {
        jobId,
        client,
        agent,
        amount: amount.toString(),
        deadline: Number(deadline),
        status: STATUS_MAP[Number(status)] ?? 'active',
      };
    } catch (error) {
      throw new EvalancheError(
        `Escrow query failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ESCROW_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
