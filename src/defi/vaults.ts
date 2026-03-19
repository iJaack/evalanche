/**
 * Minimal ERC-4626 vault client.
 */

import { Contract, MaxUint256, formatUnits, parseUnits } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import type { TransactionResult } from '../wallet/types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { VaultInfo, VaultQuote } from './types';

export const YOUSD_VAULT = '0x0000000F2Eb9f69274678c76222B35eEC7588A65';

const ERC4626_ABI = [
  'function name() view returns (string)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function previewDeposit(uint256 assets) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
] as const;

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
] as const;

export class VaultClient {
  constructor(
    private readonly signer: AgentSigner,
    private readonly chain = 'avalanche',
  ) {}

  private vault(vaultAddress: string): Contract {
    return new Contract(vaultAddress, ERC4626_ABI, this.signer);
  }

  private erc20(tokenAddress: string): Contract {
    return new Contract(tokenAddress, ERC20_ABI, this.signer);
  }

  async vaultInfo(vaultAddress: string): Promise<VaultInfo> {
    try {
      const vault = this.vault(vaultAddress);
      const [name, asset, totalAssets, decimals] = await Promise.all([
        vault.name(),
        vault.asset(),
        vault.totalAssets(),
        vault.decimals(),
      ]);

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
        `Vault info failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async depositQuote(vaultAddress: string, assets: string): Promise<VaultQuote> {
    try {
      const vault = this.vault(vaultAddress);
      const decimals: number = await vault.decimals();
      const amount = parseUnits(assets, decimals);
      const shares = await vault.previewDeposit(amount);

      return {
        shares: formatUnits(shares, decimals),
        expectedAssets: assets,
      };
    } catch (error) {
      throw new EvalancheError(
        `Vault deposit quote failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deposit(vaultAddress: string, assets: string): Promise<TransactionResult> {
    try {
      const vault = this.vault(vaultAddress);
      const assetAddress: string = await vault.asset();
      const decimals: number = await vault.decimals();
      const amount = parseUnits(assets, decimals);
      const token = this.erc20(assetAddress);

      const allowance = await token.allowance(this.signer.address, vaultAddress);
      if (allowance < amount) {
        const approveTx = await token.approve(vaultAddress, MaxUint256);
        await approveTx.wait();
      }

      const tx = await vault.deposit(amount, this.signer.address);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');
      return { hash: tx.hash, receipt };
    } catch (error) {
      throw new EvalancheError(
        `Vault deposit failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async withdrawQuote(vaultAddress: string, shares: string): Promise<VaultQuote> {
    try {
      const vault = this.vault(vaultAddress);
      const decimals: number = await vault.decimals();
      const shareAmount = parseUnits(shares, decimals);
      const assets = await vault.previewRedeem(shareAmount);

      return {
        shares,
        expectedAssets: formatUnits(assets, decimals),
      };
    } catch (error) {
      throw new EvalancheError(
        `Vault withdraw quote failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async withdraw(vaultAddress: string, shares: string): Promise<TransactionResult> {
    try {
      const vault = this.vault(vaultAddress);
      const decimals: number = await vault.decimals();
      const shareAmount = parseUnits(shares, decimals);
      const tx = await vault.redeem(shareAmount, this.signer.address, this.signer.address);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');
      return { hash: tx.hash, receipt };
    } catch (error) {
      throw new EvalancheError(
        `Vault withdraw failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.VAULT_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }
}
