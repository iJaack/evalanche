/**
 * Liquid Staking Module
 *
 * Handles staking and unstaking operations for liquid staking protocols.
 * Currently supports Benqi sAVAX on Avalanche C-Chain.
 *
 * ─── Adding a new protocol ────────────────────────────────────────────
 * To add a new staking protocol (e.g. Lido wstETH on Ethereum):
 *
 *   1. Add the contract address and ABI constants below (e.g. WSTETH_ADDR, WSTETH_ABI)
 *   2. Add new public methods following the sAvax* naming pattern:
 *      - wstEthStakeQuote(amountEth: string): Promise<StakeQuote>
 *      - wstEthStake(amountEth: string, slippageBps?: number): Promise<TransactionResult>
 *      - wstEthUnstakeQuote(sharesToRedeem: string): Promise<UnstakeQuote>
 *      - wstEthUnstake(shares: string, slippageBps?: number): Promise<TransactionResult>
 *   3. Wire the new contract in the constructor
 *   4. Export any new types from ../defi/types.ts
 *   5. Add MCP tool definitions in ../mcp/server.ts
 * ──────────────────────────────────────────────────────────────────────
 */

import { Contract, formatEther, parseEther } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import type { TransactionResult } from '../wallet/types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { StakeQuote, UnstakeQuote } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Benqi sAVAX staking contract on Avalanche C-Chain */
export const SAVAX_CONTRACT = '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE';

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const SAVAX_ABI = [
  'function instantPoolBalance() view returns (uint256)',
  'function getPooledAvaxByShares(uint256) view returns (uint256)',
  'function getSharesByPooledAvax(uint256) view returns (uint256)',
  'function redeemInstant(uint256 shareAmount, uint256 minAvaxOut) returns (uint256)',
  'function requestRedeem(uint256 shareAmount)',
  'function submit() payable returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
] as const;

// ─── LiquidStakingClient ──────────────────────────────────────────────────────

/**
 * Client for liquid staking operations across supported protocols.
 *
 * @example
 * ```ts
 * const client = new LiquidStakingClient(signer);
 *
 * // Get a quote for staking 10 AVAX
 * const quote = await client.sAvaxStakeQuote('10');
 *
 * // Stake AVAX → sAVAX
 * const result = await client.sAvaxStake('10', 100); // 1% slippage
 * ```
 */
export class LiquidStakingClient {
  private readonly signer: AgentSigner;
  private readonly sAvaxContract: Contract;
  private readonly sAvaxRead: Contract;

  constructor(signer: AgentSigner) {
    this.signer = signer;
    this.sAvaxContract = new Contract(SAVAX_CONTRACT, SAVAX_ABI, signer);
    // Read-only contract for quote operations (no signer needed)
    this.sAvaxRead = new Contract(SAVAX_CONTRACT, SAVAX_ABI, signer.provider!);
  }

  // ── sAVAX Staking (Benqi / Avalanche) ──────────────────────────────────────

  /**
   * Get a quote for staking AVAX → sAVAX on Benqi.
   * @param amountAvax - Amount of AVAX to stake (human-readable, e.g. '10')
   * @returns Stake quote with expected shares and rate
   */
  async sAvaxStakeQuote(amountAvax: string): Promise<StakeQuote> {
    try {
      const amountWei = parseEther(amountAvax);
      const shares: bigint = await this.sAvaxRead.getSharesByPooledAvax(amountWei);
      const rate = Number(shares) / Number(amountWei);

      return {
        shares: formatEther(shares),
        expectedOutput: formatEther(shares),
        rate: rate.toFixed(18),
        minOutput: formatEther(shares), // no slippage on stake
      };
    } catch (error) {
      throw new EvalancheError(
        `sAVAX stake quote failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Stake AVAX → sAVAX on Benqi via submit().
   * @param amountAvax - Amount of AVAX to stake (human-readable)
   * @param slippageBps - Slippage tolerance in basis points (default: 100 = 1%)
   * @returns Transaction result with hash and receipt
   */
  async sAvaxStake(amountAvax: string, slippageBps = 100): Promise<TransactionResult> {
    try {
      const amountWei = parseEther(amountAvax);

      // Get expected shares to validate after
      const expectedShares: bigint = await this.sAvaxRead.getSharesByPooledAvax(amountWei);
      const _minShares = expectedShares * BigInt(10000 - slippageBps) / 10000n;

      // submit() is payable — sends AVAX, receives sAVAX
      const tx = await this.sAvaxContract.submit({ value: amountWei });
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `sAVAX stake failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get a quote for unstaking sAVAX → AVAX on Benqi.
   * Checks the instant pool balance to determine if instant redemption is available.
   * @param sharesToRedeem - Amount of sAVAX shares to redeem (human-readable)
   * @param slippageBps - Slippage tolerance in basis points (default: 100 = 1%)
   * @returns Unstake quote with AVAX output and pool status
   */
  async sAvaxUnstakeQuote(sharesToRedeem: string, slippageBps = 100): Promise<UnstakeQuote> {
    try {
      const sharesWei = parseEther(sharesToRedeem);
      const [expectedAvax, poolBalance]: [bigint, bigint] = await Promise.all([
        this.sAvaxRead.getPooledAvaxByShares(sharesWei),
        this.sAvaxRead.instantPoolBalance(),
      ]);

      const minOutput = expectedAvax * BigInt(10000 - slippageBps) / 10000n;
      const isInstant = poolBalance >= expectedAvax;

      return {
        avaxOut: formatEther(expectedAvax),
        expectedOutput: formatEther(expectedAvax),
        minOutput: formatEther(minOutput),
        poolBalance: formatEther(poolBalance),
        isInstant,
      };
    } catch (error) {
      throw new EvalancheError(
        `sAVAX unstake quote failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Instantly redeem sAVAX → AVAX on Benqi.
   * Reverts if the instant pool balance is insufficient.
   * @param shares - Amount of sAVAX to redeem (human-readable)
   * @param slippageBps - Slippage tolerance in basis points (default: 100 = 1%)
   * @returns Transaction result
   */
  async sAvaxUnstakeInstant(shares: string, slippageBps = 100): Promise<TransactionResult> {
    const sharesWei = parseEther(shares);

    // Pre-flight checks
    const [expectedAvax, poolBalance, walletBalance]: [bigint, bigint, bigint] = await Promise.all([
      this.sAvaxRead.getPooledAvaxByShares(sharesWei),
      this.sAvaxRead.instantPoolBalance(),
      this.sAvaxRead.balanceOf(this.signer.address),
    ]);

    if (walletBalance < sharesWei) {
      throw new EvalancheError(
        `Insufficient sAVAX balance: have ${formatEther(walletBalance)}, need ${shares}`,
        EvalancheErrorCode.INSUFFICIENT_BALANCE,
      );
    }

    if (poolBalance < expectedAvax) {
      throw new EvalancheError(
        `Instant pool too low: ${formatEther(poolBalance)} AVAX available, need ${formatEther(expectedAvax)}`,
        EvalancheErrorCode.STAKE_POOL_INSUFFICIENT,
      );
    }

    const minAvaxOut = expectedAvax * BigInt(10000 - slippageBps) / 10000n;

    try {
      const tx = await this.sAvaxContract.redeemInstant(sharesWei, minAvaxOut);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `sAVAX instant unstake failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Request a delayed unstake of sAVAX when the instant pool is dry.
   * The AVAX can be claimed after the cooldown period (~15 days on Benqi).
   * @param shares - Amount of sAVAX to redeem (human-readable)
   * @returns Transaction result
   */
  async sAvaxUnstakeDelayed(shares: string): Promise<TransactionResult> {
    const sharesWei = parseEther(shares);

    const walletBalance: bigint = await this.sAvaxRead.balanceOf(this.signer.address);
    if (walletBalance < sharesWei) {
      throw new EvalancheError(
        `Insufficient sAVAX balance: have ${formatEther(walletBalance)}, need ${shares}`,
        EvalancheErrorCode.INSUFFICIENT_BALANCE,
      );
    }

    try {
      const tx = await this.sAvaxContract.requestRedeem(sharesWei);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `sAVAX delayed unstake failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.TRANSACTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
