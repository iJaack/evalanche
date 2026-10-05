import type { AvalancheSigner } from './signer';
import type { AvalancheProvider } from './provider';
import type { StakeInfo, ValidatorInfo, MinStakeAmounts } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * P-Chain (PVM) operations.
 * Handles staking (delegation/validation), cross-chain transfers,
 * and validator queries on the Platform Chain.
 */
export class PChainOperations {
  private readonly signer: AvalancheSigner;
  private readonly provider: AvalancheProvider;

  constructor(signer: AvalancheSigner, provider: AvalancheProvider) {
    this.signer = signer;
    this.provider = provider;
  }

  /** Get bech32-encoded P-Chain address */
  getAddress(): string {
    return this.signer.getCurrentAddress('P');
  }

  /**
   * Get P-Chain AVAX balance (via UTXOs).
   * @returns Balance in nAVAX as bigint
   */
  async getBalance(): Promise<bigint> {
    try {
      return await this.provider.getPBalance(this.getAddress());
    } catch (error) {
      throw new EvalancheError(
        'Failed to get P-Chain balance',
        EvalancheErrorCode.PCHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Export AVAX from P-Chain to another chain.
   * @param amount - Amount in nAVAX
   * @param destination - Target chain ('X' or 'C')
   * @returns Transaction ID
   */
  async exportTo(amount: bigint, destination: 'X' | 'C'): Promise<string> {
    try {
      return await this.signer.exportP(amount, destination);
    } catch (error) {
      throw new EvalancheError(
        `Failed to export from P-Chain to ${destination}`,
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Import AVAX to P-Chain from another chain.
   * @param sourceChain - Source chain ('X' or 'C')
   * @returns Transaction ID
   */
  async importFrom(sourceChain: 'X' | 'C'): Promise<string> {
    try {
      return await this.signer.importP(sourceChain);
    } catch (error) {
      throw new EvalancheError(
        `Failed to import to P-Chain from ${sourceChain}`,
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Delegate AVAX to a validator on the Primary Network.
   * @param nodeId - Validator node ID (e.g. 'NodeID-...')
   * @param stakeAmount - Amount in nAVAX to delegate
   * @param startDate - Retained for API compatibility; current Avalanche transactions begin when accepted
   * @param endDate - Unix timestamp (seconds) for delegation end
   * @param rewardAddress - Optional reward address
   * @returns Transaction ID
   */
  async addDelegator(
    nodeId: string,
    stakeAmount: bigint,
    startDate: bigint,
    endDate: bigint,
    rewardAddress?: string,
  ): Promise<string> {
    try {
      void startDate;
      return await this.signer.addDelegator(
        nodeId,
        stakeAmount,
        endDate,
        rewardAddress ?? this.getAddress(),
      );
    } catch (error) {
      throw new EvalancheError(
        `Failed to delegate to ${nodeId}`,
        EvalancheErrorCode.STAKING_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get current staking info for the signer's address.
   * @returns Array of stake info
   */
  async getStake(): Promise<StakeInfo[]> {
    try {
      const staked = (await this.provider.getPStake(this.getAddress())).toString();
      return [{ staked }];
    } catch (error) {
      throw new EvalancheError(
        'Failed to get staking info',
        EvalancheErrorCode.STAKING_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get current validators on the Primary Network.
   * @param limit - Max validators to return (default 100)
   */
  async getCurrentValidators(limit?: number): Promise<ValidatorInfo[]> {
    try {
      const validators = (await this.provider.getCurrentValidators()).slice(0, limit ?? 100);
      return validators.map((v) => ({
        nodeId: v.nodeID,
        stakeAmount: v.stakeAmount,
        startTime: Number(v.startTime),
        endTime: Number(v.endTime),
        delegationFee: Number(v.delegationFee ?? 0),
        uptime: Number(v.uptime ?? 0),
        connected: Boolean(v.connected),
      }));
    } catch (error) {
      throw new EvalancheError(
        'Failed to get current validators',
        EvalancheErrorCode.PCHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get minimum stake amounts for validators and delegators.
   */
  async getMinStake(): Promise<MinStakeAmounts> {
    try {
      const response = await this.provider.getMinStake();
      return {
        minValidatorStake: response.minValidatorStake.toString(),
        minDelegatorStake: response.minDelegatorStake.toString(),
      };
    } catch (error) {
      throw new EvalancheError(
        'Failed to get min stake amounts',
        EvalancheErrorCode.PCHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
