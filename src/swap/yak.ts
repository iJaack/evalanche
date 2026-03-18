/**
 * Yield Yak Swap Module
 *
 * DEX aggregator for Avalanche and other EVM chains.
 * Finds optimal swap paths between any two tokens considering amount-out and gas costs.
 *
 * Key contracts (Avalanche):
 *   - YakRouter: 0xC4729E56b831d74bBc18797e0e17A295fA77488c
 *
 * Chains supported:
 *   - Avalanche: 0xC4729E56b831d74bBc18797e0e17A295fA77488c
 *   - Arbitrum: 0xb32C79a25291265eF240Eb32E9faBbc6DcEE3cE3
 *   - Optimism: 0xCd887F78c77b36B0b541E77AfD6F91C0253182A2
 */

import { Contract, parseUnits, formatUnits, MaxUint256 } from 'ethers';
import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

// ─── Constants ────────────────────────────────────────────────────────────────

/** YakRouter address on Avalanche C-Chain */
export const YAK_ROUTER_AVALANCHE = '0xC4729E56b831d74bBc18797e0e17A295fA77488c';

/** YakRouter address on Arbitrum */
export const YAK_ROUTER_ARBITRUM = '0xb32C79a25291265eF240Eb32E9faBbc6DcEE3cE3';

/** YakRouter address on Optimism */
export const YAK_ROUTER_OPTIMISM = '0xCd887F78c77b36B0b541E77AfD6F91C0253182A2';

/** Default max steps for path finding (must be < 4) */
const DEFAULT_MAX_STEPS = 3;

/** Default gas price in gwei for estimation */
const DEFAULT_GAS_PRICE_GWEI = 0.1;

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const YAK_ROUTER_ABI = [
  'function findBestPathWithGas(uint256 _amountIn, address _tokenIn, address _tokenOut, uint256 _maxSteps, uint256 _gasPrice) external view returns (tuple(uint256[] amounts, address[] adapters, address[] path, uint256 gasEstimate))',
  'function swapNoSplit(tuple(uint256 amountIn, uint256 amountOut, address[] path, address[] adapters) _trade, address _to, uint256 _fee) external',
  'function swap(uint256 amountIn, uint256 amountOutMin, address[] path, address[] adapters, address to, uint256 deadline) external',
] as const;

const ERC20_ABI = [
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function decimals() external view returns (uint8)',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Supported chain IDs */
export type YakChain = 'avalanche' | 'arbitrum' | 'optimism';

/** Mapping from chain name to router address */
export const YAK_ROUTER_BY_CHAIN: Record<YakChain, string> = {
  avalanche: YAK_ROUTER_AVALANCHE,
  arbitrum: YAK_ROUTER_ARBITRUM,
  optimism: YAK_ROUTER_OPTIMISM,
};

/** Formatted offer returned by findBestPathWithGas */
export interface YakOffer {
  amounts: bigint[];
  adapters: string[];
  path: string[];
  gasEstimate: bigint;
}

/** Trade parameters for swapNoSplit */
export interface YakTrade {
  amountIn: bigint;
  amountOut: bigint;
  path: string[];
  adapters: string[];
}

/** Result of a swap */
export interface YakSwapResult {
  txHash: string;
  success: boolean;
  amountOut: bigint;
}

/** Quote result with pricing info */
export interface YakQuote {
  offer: YakOffer;
  amountOutFormatted: string;
  gasEstimate: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

export function getYakRouter(chain: YakChain): string {
  return YAK_ROUTER_BY_CHAIN[chain];
}

async function getTokenDecimals(tokenAddr: string, signer: AgentSigner): Promise<number> {
  const erc20 = new Contract(tokenAddr, ERC20_ABI, signer);
  try {
    return await erc20.decimals();
  } catch {
    return 18;
  }
}

// ─── YieldYakClient ──────────────────────────────────────────────────────────

export class YieldYakClient {
  private readonly signer: AgentSigner;
  private readonly router: Contract;

  constructor(signer: AgentSigner, chain: YakChain = 'avalanche') {
    this.signer = signer;
    const routerAddr = getYakRouter(chain);
    this.router = new Contract(routerAddr, YAK_ROUTER_ABI, signer);
  }

  static withRouter(signer: AgentSigner, routerAddress: string): YieldYakClient {
    const client = Object.create(YieldYakClient.prototype);
    client.signer = signer;
    client.router = new Contract(routerAddress, YAK_ROUTER_ABI, signer);
    return client;
  }

  async quote(
    amountIn: bigint,
    tokenIn: string,
    tokenOut: string,
    maxSteps: number = DEFAULT_MAX_STEPS,
    gasPriceGwei: number = DEFAULT_GAS_PRICE_GWEI,
  ): Promise<YakQuote> {
    const [tokenInDecimals, tokenOutDecimals] = await Promise.all([
      getTokenDecimals(tokenIn, this.signer),
      getTokenDecimals(tokenOut, this.signer),
    ]);

    try {
      const result = await this.router.findBestPathWithGas(
        amountIn,
        tokenIn,
        tokenOut,
        maxSteps,
        parseUnits(gasPriceGwei.toString(), 9),
      );

      const offer: YakOffer = {
        amounts: result.amounts.map((a: bigint) => BigInt(a)),
        adapters: result.adapters,
        path: result.path,
        gasEstimate: BigInt(result.gasEstimate),
      };

      const amountOut = offer.amounts[offer.amounts.length - 1];

      return {
        offer,
        amountOutFormatted: formatUnits(amountOut, tokenOutDecimals),
        gasEstimate: offer.gasEstimate,
        tokenInDecimals,
        tokenOutDecimals,
      };
    } catch (error) {
      throw new EvalancheError(
        `Yield Yak quote failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.QUOTE_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async swap(
    amountIn: bigint,
    offer: YakOffer,
    slippage: number,
    to?: string,
    fee: number = 0,
  ): Promise<YakSwapResult> {
    const amountOut = offer.amounts[offer.amounts.length - 1];
    const minAmountOut = (amountOut * BigInt(Math.floor((1 - slippage) * 10000))) / 10000n;

    const tokenIn = offer.path[0];
    await this._ensureAllowance(tokenIn, this.router.target as string, amountIn);

    const recipient = to ?? this.signer.address;

    try {
      const trade: YakTrade = {
        amountIn,
        amountOut: minAmountOut,
        path: offer.path,
        adapters: offer.adapters,
      };

      const tx = await this.router.swapNoSplit(trade, recipient, fee);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      return {
        txHash: tx.hash,
        success: receipt.status === 1,
        amountOut,
      };
    } catch (error) {
      throw new EvalancheError(
        `Yield Yak swap failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async swapSingle(
    amountIn: bigint,
    amountOutMin: bigint,
    path: string[],
    adapters: string[],
    to?: string,
    deadline?: number,
  ): Promise<YakSwapResult> {
    const tokenIn = path[0];
    await this._ensureAllowance(tokenIn, this.router.target as string, amountIn);

    const recipient = to ?? this.signer.address;
    const deadline_ = deadline ?? Math.floor(Date.now() / 1000) + 20 * 60;

    try {
      const tx = await this.router.swap(amountIn, amountOutMin, path, adapters, recipient, deadline_);
      const receipt = await tx.wait();
      if (!receipt) throw new Error('Transaction receipt is null');

      const amountOut = amountOutMin;

      return {
        txHash: tx.hash,
        success: receipt.status === 1,
        amountOut,
      };
    } catch (error) {
      throw new EvalancheError(
        `Yield Yak swapSingle failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.SWAP_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

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
