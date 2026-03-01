/**
 * Li.Fi integration for cross-chain token bridging.
 *
 * Uses the Li.Fi REST API (https://li.quest/v1) for quotes and routes,
 * then builds and sends the transaction via the agent's ethers signer.
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { parseUnits } from 'ethers';

const LIFI_API = 'https://li.quest/v1';

/** Native token address constant used by Li.Fi */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** Parameters for requesting a bridge quote */
export interface BridgeQuoteParams {
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID */
  toChainId: number;
  /** Source token address (use NATIVE_TOKEN for native gas token) */
  fromToken: string;
  /** Destination token address (use NATIVE_TOKEN for native gas token) */
  toToken: string;
  /** Human-readable amount to send (e.g. '0.1') */
  fromAmount: string;
  /** Sender address */
  fromAddress: string;
  /** Receiver address (defaults to fromAddress) */
  toAddress?: string;
  /** Slippage tolerance as decimal (default 0.03 = 3%) */
  slippage?: number;
  /** Token decimals for fromToken (default 18) */
  fromDecimals?: number;
}

/** A bridge quote returned by Li.Fi */
export interface BridgeQuote {
  /** Quote ID */
  id: string;
  /** Source chain ID */
  fromChainId: number;
  /** Destination chain ID */
  toChainId: number;
  /** Source token address */
  fromToken: string;
  /** Destination token address */
  toToken: string;
  /** Amount to send (in wei/smallest unit) */
  fromAmount: string;
  /** Expected amount to receive (in wei/smallest unit) */
  toAmount: string;
  /** Estimated gas cost in USD */
  estimatedGas: string;
  /** Estimated completion time in seconds */
  estimatedTime: number;
  /** Bridge/DEX tool used (e.g. 'across', 'stargate', 'hop') */
  tool: string;
  /** Raw Li.Fi route object (needed for execution) */
  rawRoute: unknown;
}

/**
 * Li.Fi bridge client — handles cross-chain token bridging via the Li.Fi REST API.
 */
export class LiFiClient {
  private signer: AgentSigner;

  constructor(signer: AgentSigner) {
    this.signer = signer;
  }

  /**
   * Get a single best bridge quote from Li.Fi.
   * @param params - Bridge quote parameters
   * @returns The best available bridge quote
   */
  async getQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    const decimals = params.fromDecimals ?? 18;
    const fromAmount = parseUnits(params.fromAmount, decimals).toString();

    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      slippage: (params.slippage ?? 0.03).toString(),
      integrator: 'evalanche',
    });

    const res = await fetch(`${LIFI_API}/quote?${searchParams}`);

    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi quote failed (${res.status}): ${body}`,
        EvalancheErrorCode.BRIDGE_QUOTE_FAILED,
      );
    }

    const data = await res.json() as Record<string, unknown>;
    return this.parseQuote(data);
  }

  /**
   * Get multiple bridge route options from Li.Fi.
   * @param params - Bridge quote parameters
   * @returns Array of available bridge quotes
   */
  async getRoutes(params: BridgeQuoteParams): Promise<BridgeQuote[]> {
    const decimals = params.fromDecimals ?? 18;
    const fromAmount = parseUnits(params.fromAmount, decimals).toString();

    const body = {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount,
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      options: {
        slippage: params.slippage ?? 0.03,
        integrator: 'evalanche',
        order: 'RECOMMENDED',
      },
    };

    const res = await fetch(`${LIFI_API}/advanced/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi routes failed (${res.status}): ${errorBody}`,
        EvalancheErrorCode.BRIDGE_QUOTE_FAILED,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    const routes = data.routes ?? [];
    return routes.map((route: Record<string, unknown>) => this.parseRoute(route));
  }

  /**
   * Execute a bridge quote by building and sending the transaction.
   * @param quote - A previously obtained bridge quote
   * @returns Transaction hash and status
   */
  async execute(quote: BridgeQuote): Promise<{ txHash: string; status: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRoute = quote.rawRoute as any;

    // Extract transaction request from the quote/route
    const txRequest = rawRoute.transactionRequest ?? rawRoute.action?.transactionRequest;
    if (!txRequest) {
      throw new EvalancheError(
        'No transaction request found in quote — re-fetch the quote before executing',
        EvalancheErrorCode.BRIDGE_EXECUTION_FAILED,
      );
    }

    try {
      const tx = await this.signer.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value ? BigInt(txRequest.value) : undefined,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
        gasPrice: txRequest.gasPrice ? BigInt(txRequest.gasPrice) : undefined,
      });

      const receipt = await tx.wait();
      return {
        txHash: tx.hash,
        status: receipt?.status === 1 ? 'success' : 'failed',
      };
    } catch (error) {
      throw new EvalancheError(
        `Bridge execution failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.BRIDGE_EXECUTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /** Parse a Li.Fi /quote response into a BridgeQuote */
  private parseQuote(data: Record<string, unknown>): BridgeQuote {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;
    const action = d.action ?? {};
    const estimate = d.estimate ?? {};

    return {
      id: d.id ?? d.tool ?? 'unknown',
      fromChainId: action.fromChainId ?? 0,
      toChainId: action.toChainId ?? 0,
      fromToken: action.fromToken?.address ?? '',
      toToken: action.toToken?.address ?? '',
      fromAmount: action.fromAmount ?? '0',
      toAmount: estimate.toAmount ?? '0',
      estimatedGas: estimate.gasCosts?.[0]?.amountUSD ?? '0',
      estimatedTime: estimate.executionDuration ?? 0,
      tool: d.tool ?? d.toolDetails?.name ?? 'unknown',
      rawRoute: data,
    };
  }

  /** Parse a Li.Fi route from /advanced/routes into a BridgeQuote */
  private parseRoute(route: Record<string, unknown>): BridgeQuote {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = route as any;
    const steps = r.steps ?? [];
    const firstStep = steps[0] ?? {};
    const action = firstStep.action ?? {};
    const estimate = firstStep.estimate ?? {};

    return {
      id: r.id ?? 'unknown',
      fromChainId: r.fromChainId ?? action.fromChainId ?? 0,
      toChainId: r.toChainId ?? action.toChainId ?? 0,
      fromToken: r.fromToken?.address ?? action.fromToken?.address ?? '',
      toToken: r.toToken?.address ?? action.toToken?.address ?? '',
      fromAmount: r.fromAmount ?? action.fromAmount ?? '0',
      toAmount: r.toAmount ?? estimate.toAmount ?? '0',
      estimatedGas: r.gasCostUSD ?? estimate.gasCosts?.[0]?.amountUSD ?? '0',
      estimatedTime: steps.reduce(
        (total: number, s: Record<string, unknown>) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          total + ((s as any).estimate?.executionDuration ?? 0),
        0,
      ),
      tool: firstStep.tool ?? firstStep.toolDetails?.name ?? 'unknown',
      rawRoute: route,
    };
  }
}
