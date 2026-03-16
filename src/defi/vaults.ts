/**
 * EIP-4626 Vault Module
 *
 * Generic client for depositing into and withdrawing from EIP-4626 tokenized vaults.
 * Works with any compliant vault on any EVM chain.
 */

import { Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import type { TransactionResult } from '../wallet/types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { VaultQuote, VaultInfo, VaultConfig } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** yoUSD vault on Base (USDC underlying, 6 decimals) */
export const YOUSD_VAULT = '0x0000000f2eb9f69274678c76222b35eec7588a65';
export const YOUSD_VAULT_CHAIN = 'base';
export const YOUSD_VAULT_DECIMALS = 6;

/** Known vault configs for convenience */
export const KNOWN_VAULTS: Record<string, VaultConfig> = {
  'yousd-base': {
    contractAddress: YOUSD_VAULT,
    chain: YOUSD_VAULT_CHAIN,
    assetDecimals: YOUSD_VAULT_DECIMALS,
  },
};

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const ERC4626_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

// ─── VaultClient ──────────────────────────────────────────────────────────────

/**
 * Client for EIP-4626 vault operations (deposit, withdraw, quote, info).
 *
 * @example
 * ```ts
 * const client = new VaultClient(signer, 'base');
 *
 * // Get vault info
 * const info = await client.vaultInfo(YOUSD_VAULT);
 *
 * // Preview a deposit
 * const quote = await client.depositQuote(YOUSD_VAULT, '1000');
 *
 * // Deposit (approve + deposit in one call)
 * const result = await client.deposit(YOUSD_VAULT, '1000');
 * ```
 */
export class VaultClient {
  private readonly signer: AgentSigner;
  private readonly chain: string;

  constructor(signer: AgentSigner, chain: string) {
    this.signer = signer;
    this.chain = chain;
  }

  /**
   * Get on-chain info about an EIP-4626 vault.
   * @param vaultAddress - Vault contract address
   * @returns Vault metadata including name, asset, total assets
   */
  async vaultInfo(vaultAddress: string): Promise<VaultInfo> {
    const vault = new Contract(vaultAddress, ERC4626_ABI, this.signer.provider!);

    try {
      const [name, asset, totalAssets]: [string, string, bigint] = await Promise.all([
        vault.name(),
        vault.asset(),
        vault.totalAssets(),
      ]);

      // Try to read asset decimals for human-readable output
      const assetContract = new Contract(asset, ERC20_ABI, this.signer.provider!);
      let decimals = 18;
      try {
        decimals = Number(await assetContract.decimals());
      } catch {
        // fallback to 18
      }

      return {
        address: vaultAddress,
        chain: this.chain,
        name,
        asset,
        totalAssets: formatUnits(totalAssets, decimals),
        eip4626: true,
      };
    } catch (error) {
      throw new EvalancheError(
        `Failed to read vault info for ${vaultAddress}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Preview how many vault shares a deposit would mint.
   * @param vaultAddress - Vault contract address
   * @param assetAmount - Amount of underlying asset (human-readable)
   * @param assetDecimals - Decimals of the underlying asset (default: 6 for USDC)
   * @returns Vault quote with expected shares
   */
  async depositQuote(vaultAddress: string, assetAmount: string, assetDecimals = 6): Promise<VaultQuote> {
    const vault = new Contract(vaultAddress, ERC4626_ABI, this.signer.provider!);

    try {
      const amountRaw = parseUnits(assetAmount, assetDecimals);
      const shares: bigint = await vault.previewDeposit(amountRaw);

      // Read vault decimals for formatting
      let vaultDecimals = assetDecimals;
      try {
        vaultDecimals = Number(await vault.decimals());
      } catch {
        // fallback
      }

      return {
        shares: formatUnits(shares, vaultDecimals),
        expectedAssets: assetAmount,
      };
    } catch (error) {
      throw new EvalancheError(
        `Vault deposit quote failed for ${vaultAddress}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Approve and deposit assets into an EIP-4626 vault.
   * @param vaultAddress - Vault contract address
   * @param assetAmount - Amount of underlying asset to deposit (human-readable)
   * @param assetDecimals - Decimals of the underlying asset (default: 6 for USDC)
   * @param slippageBps - Slippage tolerance in basis points (default: 100 = 1%)
   * @returns Transaction result with hash and receipt
   */
  async deposit(vaultAddress: string, assetAmount: string, assetDecimals = 6, slippageBps = 100): Promise<TransactionResult> {
    const vault = new Contract(vaultAddress, ERC4626_ABI, this.signer);
    const vaultRead = new Contract(vaultAddress, ERC4626_ABI, this.signer.provider!);

    try {
      const amountRaw = parseUnits(assetAmount, assetDecimals);

      // Get the underlying asset address and approve
      const assetAddr: string = await vaultRead.asset();
      await this._ensureAllowance(assetAddr, vaultAddress, amountRaw);

      // Deposit
      const tx = await vault.deposit(amountRaw, this.signer.address);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Vault deposit failed for ${vaultAddress}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Preview how many assets would be returned for redeeming vault shares.
   * @param vaultAddress - Vault contract address
   * @param shareAmount - Amount of vault shares to redeem (human-readable)
   * @param shareDecimals - Decimals of the vault shares (default: 6)
   * @returns Vault quote with expected assets
   */
  async withdrawQuote(vaultAddress: string, shareAmount: string, shareDecimals = 6): Promise<VaultQuote> {
    const vault = new Contract(vaultAddress, ERC4626_ABI, this.signer.provider!);

    try {
      const sharesRaw = parseUnits(shareAmount, shareDecimals);
      const assets: bigint = await vault.previewRedeem(sharesRaw);

      // Read asset decimals for formatting
      const assetAddr: string = await vault.asset();
      const assetContract = new Contract(assetAddr, ERC20_ABI, this.signer.provider!);
      let assetDecimals = shareDecimals;
      try {
        assetDecimals = Number(await assetContract.decimals());
      } catch {
        // fallback
      }

      return {
        shares: shareAmount,
        expectedAssets: formatUnits(assets, assetDecimals),
      };
    } catch (error) {
      throw new EvalancheError(
        `Vault withdraw quote failed for ${vaultAddress}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Redeem vault shares for underlying assets.
   * @param vaultAddress - Vault contract address
   * @param shareAmount - Amount of vault shares to redeem (human-readable)
   * @param shareDecimals - Decimals of the vault shares (default: 6)
   * @param slippageBps - Slippage tolerance in basis points (default: 100 = 1%)
   * @returns Transaction result with hash and receipt
   */
  async withdraw(vaultAddress: string, shareAmount: string, shareDecimals = 6, slippageBps = 100): Promise<TransactionResult> {
    const vault = new Contract(vaultAddress, ERC4626_ABI, this.signer);

    try {
      const sharesRaw = parseUnits(shareAmount, shareDecimals);

      const tx = await vault.redeem(sharesRaw, this.signer.address, this.signer.address);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return { hash: tx.hash, receipt };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Vault withdraw failed for ${vaultAddress}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Ensure the signer has approved `spender` to spend at least `amount` of `tokenAddr`.
   * Issues an approve(spender, MaxUint256) if the current allowance is insufficient.
   */
  private async _ensureAllowance(tokenAddr: string, spender: string, amount: bigint): Promise<void> {
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
