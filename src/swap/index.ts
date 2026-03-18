/**
 * Swap Module — unified API for token swaps across different protocols.
 *
 * Provides a single entry point for:
 *   - Arena (community tokens via bonding curve)
 *   - Yield Yak (DEX aggregation)
 */

import type { AgentSigner } from '../wallet/signer';
import { ArenaSwapClient } from './arena';
import { YieldYakClient, type YakChain } from './yak';

export { ArenaSwapClient, ARENA_TOKEN_MANAGER, ARENA_TOKEN } from './arena';
export type { ArenaTokenInfo, ArenaSwapResult } from './arena';

export {
  YieldYakClient,
  YAK_ROUTER_AVALANCHE,
  YAK_ROUTER_ARBITRUM,
  YAK_ROUTER_OPTIMISM,
  getYakRouter,
} from './yak';
export type {
  YakChain,
  YakOffer,
  YakTrade,
  YakSwapResult,
  YakQuote,
} from './yak';

// ─── Unified SwapClient ────────────────────────────────────────────────────────

/** Swap protocol options */
export type SwapProtocol = 'arena' | 'yak';

/**
 * Unified swap client combining Arena and Yield Yak integrations.
 */
export class SwapClient {
  private readonly signer: AgentSigner;
  private arena: ArenaSwapClient | null = null;
  private yak: YieldYakClient | null = null;

  constructor(signer: AgentSigner) {
    this.signer = signer;
  }

  private getArena(): ArenaSwapClient {
    if (!this.arena) {
      this.arena = new ArenaSwapClient(this.signer);
    }
    return this.arena;
  }

  private getYak(chain: YakChain = 'avalanche'): YieldYakClient {
    if (!this.yak) {
      this.yak = new YieldYakClient(this.signer, chain);
    }
    return this.yak;
  }

  async quoteYak(
    amountIn: bigint,
    tokenIn: string,
    tokenOut: string,
    chain: YakChain = 'avalanche',
    maxSteps: number = 3,
    gasPriceGwei: number = 0.1,
  ): Promise<YakQuote> {
    return this.getYak(chain).quote(amountIn, tokenIn, tokenOut, maxSteps, gasPriceGwei);
  }

  async quoteArenaCost(tokenAddress: string, amount: bigint): Promise<bigint> {
    return this.getArena().calculateBuyCost(tokenAddress, amount);
  }

  async swapYak(
    amountIn: bigint,
    offer: YakOffer,
    slippage: number,
    to?: string,
    fee: number = 0,
  ): Promise<YakSwapResult> {
    return this.getYak().swap(amountIn, offer, slippage, to, fee);
  }

  async buyArena(
    tokenAddress: string,
    amountToBuy: bigint,
    maxArenaToSpend: bigint,
  ): Promise<ArenaSwapResult> {
    return this.getArena().buyArenaToken(tokenAddress, amountToBuy, maxArenaToSpend);
  }

  async sellArena(
    tokenAddress: string,
    amountToSell: bigint,
    minArenaToReceive: bigint,
  ): Promise<ArenaSwapResult> {
    return this.getArena().sellArenaToken(tokenAddress, amountToSell, minArenaToReceive);
  }

  arenaClient(): ArenaSwapClient {
    return this.getArena();
  }

  yakClient(chain: YakChain = 'avalanche'): YieldYakClient {
    return this.getYak(chain);
  }
}
