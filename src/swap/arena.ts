/**
 * Arena Token Swap Module
 *
 * Supports buying and selling community tokens on Arena.social via the
 * ArenaTokenManager bonding-curve contract on Avalanche C-Chain.
 *
 * Key contracts:
 *   - ArenaTokenManager proxy:  0x2196e106af476f57618373EC028924767c758464
 *   - ARENA token (Avalanche):  0xB8d7710f7d8349A506b75dD184F05777c82dAd0C
 *
 * Token IDs start at 100000000001 and currently go up to ~100000003609.
 * getArenaTokenId() resolves a token address → tokenId by scanning in parallel
 * batches and caches the result for 1 hour (token IDs are immutable once set).
 */

import { Contract, parseUnits, MaxUint256 } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import { TTLCache } from '../utils/cache';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

// ─── Constants ────────────────────────────────────────────────────────────────

/** ArenaTokenManager proxy address (Avalanche C-Chain) */
export const ARENA_TOKEN_MANAGER = '0x2196e106af476f57618373EC028924767c758464';

/** $ARENA ERC-20 token address (Avalanche C-Chain) */
export const ARENA_TOKEN = '0xB8d7710f7d8349A506b75dD184F05777c82dAd0C';

/** Smallest token ID ever registered */
const TOKEN_ID_MIN = 100_000_000_001n;

/** Upper bound for scanning — increase if new tokens are registered beyond this */
const TOKEN_ID_MAX = 100_000_004_000n;

/** How many getTokenInfo calls to fire in parallel per batch */
const SCAN_BATCH_SIZE = 50;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ARENA_TOKEN_MANAGER_ABI = [
  // Buy community tokens by spending $ARENA
  'function buyAndCreateLpIfPossible(uint256 amount, uint256 _tokenId, uint256 maxArenaToSpend) external',
  // Sell community tokens to receive $ARENA
  'function sell(uint256 amount, uint256 _tokenId, uint256 minArenaToReceive) external',
  // Get the cost (in $ARENA) to buy `amountInToken` of token `_tokenId`
  'function calculateCostWithFees(uint256 amountInToken, uint256 _tokenId) external view returns (uint256)',
  // Token metadata — returns a struct, we decode the fields individually
  'function getTokenInfo(uint256 _tokenId) external view returns (uint8 protocolFee, uint8 creatorFee, uint8 referralFee, uint88 tokenCreationBuyFee, uint128 curveScaler, uint32 a, address tokenAddress)',
] as const;

const ERC20_ABI = [
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Raw token info returned by ArenaTokenManager.getTokenInfo */
export interface ArenaTokenInfo {
  protocolFee: number;
  creatorFee: number;
  referralFee: number;
  tokenCreationBuyFee: bigint;
  curveScaler: bigint;
  a: number;
  tokenAddress: string;
}

/** Result of a buy or sell swap */
export interface ArenaSwapResult {
  /** Transaction hash */
  txHash: string;
  /** Whether the transaction was mined successfully */
  success: boolean;
  /** tokenId used in the call */
  tokenId: bigint;
}

// ─── Module-level cache (shared across all ArenaSwapClient instances) ─────────

/**
 * Cache of tokenAddress (lowercase) → tokenId.
 * TTL = 1 hour; token IDs are immutable so long TTL is safe.
 */
const tokenIdCache = new TTLCache<bigint>(60 * 60 * 1000);

// ─── ArenaSwapClient ──────────────────────────────────────────────────────────

/**
 * Client for buying and selling Arena community tokens via ArenaTokenManager.
 *
 * @example
 * ```ts
 * const client = new ArenaSwapClient(signer);
 *
 * // Find out the $ARENA cost for 100 $EVA tokens
 * const cost = await client.calculateBuyCost(EVA_TOKEN, parseUnits('100', 18));
 *
 * // Buy 100 $EVA tokens, spending at most 50 $ARENA
 * await client.buyArenaToken(EVA_TOKEN, parseUnits('100', 18), parseUnits('50', 18));
 * ```
 */
export class ArenaSwapClient {
  private readonly signer: AgentSigner;
  private readonly manager: Contract;

  constructor(signer: AgentSigner) {
    this.signer = signer;
    this.manager = new Contract(ARENA_TOKEN_MANAGER, ARENA_TOKEN_MANAGER_ABI, signer);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Buy `amountToBuy` community tokens by spending up to `maxArenaToSpend` $ARENA.
   *
   * This method automatically:
   *   1. Resolves the Arena tokenId from `tokenAddress`
   *   2. Approves $ARENA to ArenaTokenManager if the current allowance is too low
   *   3. Calls buyAndCreateLpIfPossible
   *
   * @param tokenAddress  ERC-20 address of the community token to buy
   * @param amountToBuy   Amount of community tokens to purchase (in wei)
   * @param maxArenaToSpend  Maximum $ARENA willing to spend (in wei)
   */
  async buyArenaToken(
    tokenAddress: string,
    amountToBuy: bigint,
    maxArenaToSpend: bigint,
  ): Promise<ArenaSwapResult> {
    const tokenId = await this.getArenaTokenId(tokenAddress);

    // Ensure $ARENA allowance is sufficient
    await this._ensureAllowance(ARENA_TOKEN, ARENA_TOKEN_MANAGER, maxArenaToSpend);

    try {
      const tx = await this.manager.buyAndCreateLpIfPossible(amountToBuy, tokenId, maxArenaToSpend);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return {
        txHash: tx.hash,
        success: receipt.status === 1,
        tokenId,
      };
    } catch (error) {
      throw new EvalancheError(
        `Arena buy failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ARENA_SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Sell `amountToSell` community tokens to receive at least `minArenaToReceive` $ARENA.
   *
   * This method automatically:
   *   1. Resolves the Arena tokenId from `tokenAddress`
   *   2. Approves the community token to ArenaTokenManager if the allowance is too low
   *   3. Calls sell
   *
   * @param tokenAddress       ERC-20 address of the community token to sell
   * @param amountToSell       Amount of community tokens to sell (in wei)
   * @param minArenaToReceive  Minimum $ARENA to accept (slippage guard, in wei)
   */
  async sellArenaToken(
    tokenAddress: string,
    amountToSell: bigint,
    minArenaToReceive: bigint,
  ): Promise<ArenaSwapResult> {
    const tokenId = await this.getArenaTokenId(tokenAddress);

    // Ensure the community token allowance is sufficient for the sell
    await this._ensureAllowance(tokenAddress, ARENA_TOKEN_MANAGER, amountToSell);

    try {
      const tx = await this.manager.sell(amountToSell, tokenId, minArenaToReceive);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return {
        txHash: tx.hash,
        success: receipt.status === 1,
        tokenId,
      };
    } catch (error) {
      throw new EvalancheError(
        `Arena sell failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ARENA_SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Look up the Arena tokenId for a given ERC-20 token address.
   *
   * Scans ArenaTokenManager.getTokenInfo() in parallel batches across the
   * full token ID space. Results are cached for 1 hour.
   *
   * @param tokenAddress  ERC-20 address of the community token
   * @returns The Arena tokenId (bigint)
   * @throws EvalancheError if the token is not registered in ArenaTokenManager
   */
  async getArenaTokenId(tokenAddress: string): Promise<bigint> {
    const key = tokenAddress.toLowerCase();

    const cached = tokenIdCache.get(key);
    if (cached !== undefined) return cached;

    // Read-only contract — connect to the provider directly (no need for signer)
    const provider = this.signer.provider;
    if (!provider) {
      throw new EvalancheError(
        'Signer has no provider attached — cannot scan ArenaTokenManager',
        EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND,
      );
    }
    const readContract = new Contract(ARENA_TOKEN_MANAGER, ARENA_TOKEN_MANAGER_ABI, provider);

    const total = Number(TOKEN_ID_MAX - TOKEN_ID_MIN);
    const needle = key;

    for (let offset = 0; offset < total; offset += SCAN_BATCH_SIZE) {
      const batchPromises: Promise<{ id: bigint; addr: string } | null>[] = [];

      for (let i = 0; i < SCAN_BATCH_SIZE && offset + i < total; i++) {
        const id = TOKEN_ID_MIN + BigInt(offset + i);
        batchPromises.push(
          readContract
            .getTokenInfo(id)
            .then((info: ArenaTokenInfo) => ({
              id,
              addr: (info.tokenAddress ?? '').toLowerCase(),
            }))
            .catch(() => null), // getTokenInfo reverts for non-existent IDs
        );
      }

      const results = await Promise.all(batchPromises);
      for (const result of results) {
        if (!result) continue;
        if (result.addr === needle) {
          tokenIdCache.set(key, result.id);
          return result.id;
        }
      }
    }

    throw new EvalancheError(
      `Arena tokenId not found for address ${tokenAddress} — token may not be registered`,
      EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND,
    );
  }

  /**
   * Calculate the $ARENA cost (including fees) to buy `amount` of a community token.
   *
   * @param tokenAddress  ERC-20 address of the community token
   * @param amount        Amount of community tokens to price (in wei)
   * @returns Cost in $ARENA (wei)
   */
  async calculateBuyCost(tokenAddress: string, amount: bigint): Promise<bigint> {
    const tokenId = await this.getArenaTokenId(tokenAddress);

    try {
      const cost: bigint = await this.manager.calculateCostWithFees(amount, tokenId);
      return cost;
    } catch (error) {
      throw new EvalancheError(
        `calculateCostWithFees failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ARENA_SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Fetch raw token info from ArenaTokenManager for a given tokenId.
   * Useful for inspecting fees, curve parameters, and the associated ERC-20 address.
   *
   * @param tokenId  Arena tokenId (e.g. 100000000001n)
   */
  async getTokenInfo(tokenId: bigint): Promise<ArenaTokenInfo> {
    try {
      const info = await this.manager.getTokenInfo(tokenId);
      return {
        protocolFee: Number(info.protocolFee),
        creatorFee: Number(info.creatorFee),
        referralFee: Number(info.referralFee),
        tokenCreationBuyFee: BigInt(info.tokenCreationBuyFee),
        curveScaler: BigInt(info.curveScaler),
        a: Number(info.a),
        tokenAddress: info.tokenAddress as string,
      };
    } catch (error) {
      throw new EvalancheError(
        `getTokenInfo failed for tokenId ${tokenId}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.ARENA_TOKEN_NOT_FOUND,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Ensure the signer has approved `spender` to spend at least `amount` of `tokenAddr`.
   * Issues an approve(spender, MaxUint256) if the current allowance is insufficient.
   */
  private async _ensureAllowance(
    tokenAddr: string,
    spender: string,
    amount: bigint,
  ): Promise<void> {
    const erc20 = new Contract(tokenAddr, ERC20_ABI, this.signer);

    let allowance: bigint;
    try {
      allowance = await erc20.allowance(this.signer.address, spender);
    } catch (error) {
      throw new EvalancheError(
        `Failed to read allowance for ${tokenAddr}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }

    if (allowance >= amount) return;

    try {
      const tx = await erc20.approve(spender, MaxUint256);
      await tx.wait();
    } catch (error) {
      throw new EvalancheError(
        `Failed to approve ${tokenAddr} to ${spender}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CONTRACT_CALL_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
