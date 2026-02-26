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
      const utxoSet = await this.signer.getUTXOs('P');
      const context = this.provider.getContext();
      const avaxAssetId = context.avaxAssetID;
      let total = BigInt(0);
      for (const utxo of utxoSet.getUTXOs()) {
        if (utxo.getAssetId() === avaxAssetId && 'amount' in utxo.output) {
          total += (utxo.output as { amount: () => bigint }).amount();
        }
      }
      return total;
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
      const utxoSet = await this.signer.getUTXOs('P');
      const unsignedTx = this.signer.exportP(amount, utxoSet, destination);
      const signedUnsignedTx = await this.signer.signTx({ tx: unsignedTx });
      const signedTx = signedUnsignedTx.getSignedTx();
      const api = this.provider.getApiP();
      const response = await api.issueSignedTx(signedTx);
      return response.txID;
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
      const atomicUtxos = await this.signer.getAtomicUTXOs('P', sourceChain);
      if (atomicUtxos.getUTXOs().length === 0) {
        throw new Error('No atomic UTXOs available for import');
      }
      const unsignedTx = this.signer.importP(atomicUtxos, sourceChain);
      const signedUnsignedTx = await this.signer.signTx({ tx: unsignedTx });
      const signedTx = signedUnsignedTx.getSignedTx();
      const api = this.provider.getApiP();
      const response = await api.issueSignedTx(signedTx);
      return response.txID;
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
   * @param startDate - Unix timestamp (seconds) for delegation start
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
      const utxoSet = await this.signer.getUTXOs('P');
      const config = rewardAddress ? { rewardAddress } : undefined;
      const unsignedTx = this.signer.addDelegator(
        utxoSet,
        nodeId,
        stakeAmount,
        startDate,
        endDate,
        config,
      );
      const signedUnsignedTx = await this.signer.signTx({ tx: unsignedTx });
      const signedTx = signedUnsignedTx.getSignedTx();
      const api = this.provider.getApiP();
      const response = await api.issueSignedTx(signedTx);
      return response.txID;
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
      const stakeResponse = await this.signer.getStake();
      const staked = stakeResponse.staked.toString();
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
      const api = this.provider.getApiP();
      const response = await api.getCurrentValidators();
      const validators = (response.validators as Array<Record<string, unknown>>)
        .slice(0, limit ?? 100);
      return validators.map((v) => ({
        nodeId: String(v.nodeID ?? ''),
        stakeAmount: String(v.stakeAmount ?? '0'),
        startTime: Number(v.startTime ?? 0),
        endTime: Number(v.endTime ?? 0),
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
      const api = this.provider.getApiP();
      const response = await api.getMinStake();
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
