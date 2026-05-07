/**
 * Li.Fi integration for cross-chain token bridging.
 *
 * Uses the Li.Fi REST API (https://li.quest/v1) for quotes and routes,
 * then builds and sends the transaction via the agent's ethers signer.
 */

import type { AgentSigner } from '../wallet/signer';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
import { Contract, formatUnits, parseUnits } from 'ethers';

const LIFI_API = 'https://li.quest/v1';

/** Native token address constant used by Li.Fi */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export interface TransferStatus {
  status: 'NOT_FOUND' | 'PENDING' | 'DONE' | 'FAILED';
  substatus?: string;
  receiving?: { txHash: string; amount: string; token: string; chainId: number };
}

export interface TransferStatusParams {
  txHash: string;
  bridge?: string;
  fromChainId: number;
  toChainId: number;
}

export interface LiFiToken {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  priceUSD?: string;
  chainId: number;
}

export interface LiFiChain {
  id: number;
  key: string;
  name: string;
  chainType: string;
  nativeToken?: { symbol: string; decimals: number; address: string };
}

export interface LiFiTools {
  bridges: Array<{ key: string; name: string; logoURI?: string }>;
  exchanges: Array<{ key: string; name: string; logoURI?: string }>;
}

export interface LiFiGasPrices {
  [chainId: string]: Record<string, string>;
}

export interface LiFiGasSuggestion {
  standard: string;
  fast: string;
  slow: string;
  [key: string]: string;
}

export interface LiFiConnection {
  fromChainId: number;
  toChainId: number;
  fromTokens: LiFiToken[];
  toTokens: LiFiToken[];
}

export interface LiFiBalanceSnapshot {
  token: string;
  decimals: number;
  rawAmount: string;
  amount: string;
}

export interface LiFiExecutionResult {
  txHash: string;
  status: string;
  routeId: string;
  tool: string;
  fromChainId: number;
  toChainId: number;
  sourceReceiptStatus?: number;
  transferStatus?: TransferStatus;
  balances?: {
    fromTokenBefore?: LiFiBalanceSnapshot;
    fromTokenAfter?: LiFiBalanceSnapshot;
    toTokenBefore?: LiFiBalanceSnapshot;
    toTokenAfter?: LiFiBalanceSnapshot;
  };
  warnings: string[];
}

export type LiFiRouteOrder = 'FASTEST' | 'CHEAPEST';

export type LiFiRouteStrategy =
  | 'recommended'
  | 'minimum_slippage'
  | 'minimum_execution_time'
  | 'fastest_route'
  | 'minimum_completion_time';

export interface LiFiTimingStrategy {
  strategy?: 'minWaitTime';
  minWaitTimeMs: number;
  startingExpectedResults: number;
  reduceEveryMs: number;
}

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
  /**
   * High-level routing strategy preset. Use this when you want to bias for:
   * - `minimum_slippage`: lower slippage tolerance and stablecoin routing preset
   * - `minimum_execution_time`: faster quote/route response from LI.FI
   * - `fastest_route` / `minimum_completion_time`: shortest estimated route duration
   */
  routeStrategy?: LiFiRouteStrategy;
  /** Explicit LI.FI route ordering override */
  routeOrder?: LiFiRouteOrder;
  /** Optional LI.FI routing preset (for example `stablecoin`) */
  preset?: string;
  /** Optional max price impact filter passed through to LI.FI */
  maxPriceImpact?: number;
  /** Skip LI.FI simulation to reduce quote latency when acceptable */
  skipSimulation?: boolean;
  /** Low-level LI.FI timing strategies for swap steps */
  swapStepTimingStrategies?: LiFiTimingStrategy[];
  /** Low-level LI.FI timing strategies for route discovery */
  routeTimingStrategies?: LiFiTimingStrategy[];
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

interface LiFiResolvedRouteOptions {
  slippage?: number;
  order?: LiFiRouteOrder;
  preset?: string;
  maxPriceImpact?: number;
  skipSimulation?: boolean;
  swapStepTimingStrategies?: string[];
  routeTimingStrategies?: string[];
}

const FAST_RESPONSE_TIMING_STRATEGY: LiFiTimingStrategy = {
  strategy: 'minWaitTime',
  minWaitTimeMs: 200,
  startingExpectedResults: 1,
  reduceEveryMs: 200,
};

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
    const decimals = await this.resolveFromDecimals(params);
    const fromAmount = parseUnits(String(params.fromAmount), decimals).toString();
    const routeOptions = this.resolveRouteOptions(params);
    const fromAddress = this.normalizeEvmQuoteAddress(params.fromAddress, params.fromChainId, 'fromAddress');
    const toAddress = params.toAddress
      ? this.normalizeEvmQuoteAddress(params.toAddress, params.toChainId, 'toAddress')
      : fromAddress;

    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount,
      fromAddress,
      toAddress,
      slippage: (routeOptions.slippage ?? 0.03).toString(),
      integrator: 'evalanche',
    });
    if (routeOptions.order) searchParams.set('order', routeOptions.order);
    if (routeOptions.preset) searchParams.set('preset', routeOptions.preset);
    if (routeOptions.maxPriceImpact !== undefined) {
      searchParams.set('maxPriceImpact', routeOptions.maxPriceImpact.toString());
    }
    if (routeOptions.skipSimulation !== undefined) {
      searchParams.set('skipSimulation', String(routeOptions.skipSimulation));
    }
    for (const strategy of routeOptions.swapStepTimingStrategies ?? []) {
      searchParams.append('swapStepTimingStrategies', strategy);
    }
    for (const strategy of routeOptions.routeTimingStrategies ?? []) {
      searchParams.append('routeTimingStrategies', strategy);
    }

    const res = await safeFetch(`${LIFI_API}/quote?${searchParams}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });

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
    const decimals = await this.resolveFromDecimals(params);
    const fromAmount = parseUnits(String(params.fromAmount), decimals).toString();
    const routeOptions = this.resolveRouteOptions(params);
    const fromAddress = this.normalizeEvmQuoteAddress(params.fromAddress, params.fromChainId, 'fromAddress');
    const toAddress = params.toAddress
      ? this.normalizeEvmQuoteAddress(params.toAddress, params.toChainId, 'toAddress')
      : fromAddress;

    const body = {
      fromChainId: params.fromChainId,
      toChainId: params.toChainId,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount,
      fromAddress,
      toAddress,
      options: {
        slippage: routeOptions.slippage ?? 0.03,
        integrator: 'evalanche',
        ...(routeOptions.order ? { order: routeOptions.order } : {}),
        ...(routeOptions.preset ? { preset: routeOptions.preset } : {}),
        ...(routeOptions.maxPriceImpact !== undefined ? { maxPriceImpact: routeOptions.maxPriceImpact } : {}),
        ...(routeOptions.skipSimulation !== undefined ? { skipSimulation: routeOptions.skipSimulation } : {}),
        ...(routeOptions.swapStepTimingStrategies ? { swapStepTimingStrategies: routeOptions.swapStepTimingStrategies } : {}),
        ...(routeOptions.routeTimingStrategies ? { routeTimingStrategies: routeOptions.routeTimingStrategies } : {}),
      },
    };

    const res = await safeFetch(`${LIFI_API}/advanced/routes`, {
      timeoutMs: 15_000,
      maxBytes: 2_000_000,
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
    const detailed = await this.executeDetailed(quote);
    return { txHash: detailed.txHash, status: detailed.status };
  }

  async executeDetailed(quote: BridgeQuote): Promise<LiFiExecutionResult> {
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

    const warnings: string[] = [];
    const balanceSnapshots = await this.captureExecutionBalances(quote, warnings);

    try {
      const tx = await this.signer.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value ? BigInt(txRequest.value) : undefined,
        gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
        gasPrice: txRequest.gasPrice ? BigInt(txRequest.gasPrice) : undefined,
      });

      const receipt = await tx.wait();
      const verification = await this.verifyExecution(quote, tx.hash, warnings);
      const postBalances = await this.captureExecutionBalances(quote, warnings);

      return {
        txHash: tx.hash,
        status: receipt?.status === 1 ? 'success' : 'failed',
        routeId: quote.id,
        tool: quote.tool,
        fromChainId: quote.fromChainId,
        toChainId: quote.toChainId,
        sourceReceiptStatus: typeof receipt?.status === 'number' ? receipt.status : undefined,
        transferStatus: verification ?? undefined,
        balances: {
          fromTokenBefore: balanceSnapshots.fromToken,
          fromTokenAfter: postBalances.fromToken,
          toTokenBefore: balanceSnapshots.toToken,
          toTokenAfter: postBalances.toToken,
        },
        warnings,
      };
    } catch (error) {
      throw new EvalancheError(
        `Bridge execution failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.BRIDGE_EXECUTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async checkTransferStatus(params: TransferStatusParams): Promise<TransferStatus> {
    const searchParams = new URLSearchParams({
      txHash: params.txHash,
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
    });
    if (params.bridge) searchParams.set('bridge', params.bridge);

    const res = await safeFetch(`${LIFI_API}/status?${searchParams}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi status check failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_STATUS_ERROR,
      );
    }
    const data = await res.json() as Record<string, unknown>;
    return data as unknown as TransferStatus;
  }

  async getSwapQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    if (params.fromChainId !== params.toChainId) {
      throw new EvalancheError(
        'getSwapQuote requires same-chain (fromChainId must equal toChainId). Use getQuote for cross-chain.',
        EvalancheErrorCode.LIFI_SWAP_FAILED,
      );
    }
    return this.getQuote(params);
  }

  async getTokens(chainIds: number[]): Promise<Record<string, LiFiToken[]>> {
    const res = await safeFetch(`${LIFI_API}/tokens?chains=${chainIds.join(',')}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi get tokens failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_TOKEN_ERROR,
      );
    }
    const data = await res.json() as { tokens: Record<string, LiFiToken[]> };
    return data.tokens;
  }

  async getToken(chainId: number, address: string): Promise<LiFiToken> {
    const res = await safeFetch(`${LIFI_API}/token?chain=${chainId}&token=${address}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi get token failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_TOKEN_ERROR,
      );
    }
    return await res.json() as LiFiToken;
  }

  async getChains(chainTypes?: string[]): Promise<LiFiChain[]> {
    const url = chainTypes?.length
      ? `${LIFI_API}/chains?chainTypes=${chainTypes.join(',')}`
      : `${LIFI_API}/chains`;
    const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi get chains failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_API_ERROR,
      );
    }
    const data = await res.json() as { chains: LiFiChain[] };
    return data.chains;
  }

  async getTools(): Promise<LiFiTools> {
    const res = await safeFetch(`${LIFI_API}/tools`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi get tools failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_API_ERROR,
      );
    }
    return await res.json() as LiFiTools;
  }

  async getGasPrices(): Promise<LiFiGasPrices> {
    const res = await safeFetch(`${LIFI_API}/gas/prices`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi gas prices failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_API_ERROR,
      );
    }
    return await res.json() as LiFiGasPrices;
  }

  async getGasSuggestion(chainId: number): Promise<LiFiGasSuggestion> {
    const res = await safeFetch(`${LIFI_API}/gas/suggestion/${chainId}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi gas suggestion failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_API_ERROR,
      );
    }
    const data = await res.json() as Record<string, unknown>;

    if (typeof data.standard === 'string' || typeof data.fast === 'string' || typeof data.slow === 'string') {
      return data as LiFiGasSuggestion;
    }

    const recommended = this.readNestedString(data, ['recommended', 'amount']) ?? '0';
    const limit = this.readNestedString(data, ['limit', 'amount']) ?? recommended;

    return {
      standard: recommended,
      fast: limit,
      slow: recommended,
      recommended,
      limit,
      fromAmount: typeof data.fromAmount === 'string' ? data.fromAmount : '0',
      available: String(Boolean(data.available ?? false)),
    };
  }

  async getConnections(params: { fromChainId: number; toChainId: number; fromToken?: string; toToken?: string }): Promise<LiFiConnection[]> {
    const searchParams = new URLSearchParams({
      fromChain: params.fromChainId.toString(),
      toChain: params.toChainId.toString(),
    });
    if (params.fromToken) searchParams.set('fromToken', params.fromToken);
    if (params.toToken) searchParams.set('toToken', params.toToken);

    const res = await safeFetch(`${LIFI_API}/connections?${searchParams}`, { timeoutMs: 15_000, maxBytes: 2_000_000 });
    if (!res.ok) {
      const body = await res.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `Li.Fi connections failed (${res.status}): ${body}`,
        EvalancheErrorCode.LIFI_API_ERROR,
      );
    }
    const data = await res.json() as { connections: LiFiConnection[] };
    return data.connections;
  }

  /** Parse a Li.Fi /quote response into a BridgeQuote */
  private parseQuote(data: Record<string, unknown>): BridgeQuote {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;
    const action = d.action ?? {};
    const estimate = d.estimate ?? {};
    const fromChainId = this.expectNumber(action.fromChainId, 'quote.action.fromChainId');
    const toChainId = this.expectNumber(action.toChainId, 'quote.action.toChainId');
    const fromToken = this.expectString(action.fromToken?.address, 'quote.action.fromToken.address');
    const toToken = this.expectString(action.toToken?.address, 'quote.action.toToken.address');
    const fromAmount = this.expectString(action.fromAmount, 'quote.action.fromAmount');
    const toAmount = this.expectString(estimate.toAmount, 'quote.estimate.toAmount');
    const tool = this.expectString(d.tool ?? d.toolDetails?.name, 'quote.tool');

    return {
      id: String(d.id ?? tool),
      fromChainId,
      toChainId,
      fromToken,
      toToken,
      fromAmount,
      toAmount,
      estimatedGas: estimate.gasCosts?.[0]?.amountUSD ?? '0',
      estimatedTime: estimate.executionDuration ?? 0,
      tool,
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
    const fromChainId = this.expectNumber(r.fromChainId ?? action.fromChainId, 'route.fromChainId');
    const toChainId = this.expectNumber(r.toChainId ?? action.toChainId, 'route.toChainId');
    const fromToken = this.expectString(r.fromToken?.address ?? action.fromToken?.address, 'route.fromToken.address');
    const toToken = this.expectString(r.toToken?.address ?? action.toToken?.address, 'route.toToken.address');
    const fromAmount = this.expectString(r.fromAmount ?? action.fromAmount, 'route.fromAmount');
    const toAmount = this.expectString(r.toAmount ?? estimate.toAmount, 'route.toAmount');
    const tool = this.expectString(firstStep.tool ?? firstStep.toolDetails?.name, 'route.tool');

    return {
      id: String(r.id ?? tool),
      fromChainId,
      toChainId,
      fromToken,
      toToken,
      fromAmount,
      toAmount,
      estimatedGas: r.gasCostUSD ?? estimate.gasCosts?.[0]?.amountUSD ?? '0',
      estimatedTime: steps.reduce(
        (total: number, s: Record<string, unknown>) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          total + ((s as any).estimate?.executionDuration ?? 0),
        0,
      ),
      tool,
      rawRoute: route,
    };
  }

  private async resolveFromDecimals(params: BridgeQuoteParams): Promise<number> {
    if (params.fromDecimals !== undefined) return params.fromDecimals;
    if (params.fromToken === NATIVE_TOKEN) return 18;

    try {
      const token = await this.getToken(params.fromChainId, params.fromToken);
      return token.decimals;
    } catch {
      return 18;
    }
  }

  private async verifyExecution(
    quote: BridgeQuote,
    txHash: string,
    warnings: string[],
  ): Promise<TransferStatus | null> {
    if (quote.fromChainId === quote.toChainId) return null;

    try {
      return await this.checkTransferStatus({
        txHash,
        bridge: quote.tool,
        fromChainId: quote.fromChainId,
        toChainId: quote.toChainId,
      });
    } catch (error) {
      warnings.push(
        `Li.Fi transfer status verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async captureExecutionBalances(
    quote: BridgeQuote,
    warnings: string[],
  ): Promise<{ fromToken?: LiFiBalanceSnapshot; toToken?: LiFiBalanceSnapshot }> {
    if (!this.signer.provider) {
      warnings.push('No provider available on signer for Li.Fi balance verification.');
      return {};
    }

    try {
      const network = await this.signer.provider.getNetwork();
      if (Number(network.chainId) !== quote.fromChainId) {
        warnings.push(
          `Signer provider is on chain ${String(network.chainId)}, but Li.Fi execution expects source chain ${quote.fromChainId}.`,
        );
        return {};
      }
    } catch (error) {
      warnings.push(
        `Unable to read signer network for Li.Fi balance verification: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }

    const [fromToken, toToken] = await Promise.all([
      this.readTokenBalance(quote.fromChainId, quote.fromToken).catch((error) => {
        warnings.push(`Unable to snapshot source token balance: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }),
      quote.fromChainId === quote.toChainId
        ? this.readTokenBalance(quote.toChainId, quote.toToken).catch((error) => {
          warnings.push(`Unable to snapshot destination token balance: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        })
        : Promise.resolve(undefined),
    ]);

    return { fromToken, toToken };
  }

  private async readTokenBalance(chainId: number, tokenAddress: string): Promise<LiFiBalanceSnapshot> {
    if (!this.signer.provider) {
      throw new Error('Signer has no provider');
    }
    const address = await this.signer.getAddress();

    if (tokenAddress === NATIVE_TOKEN) {
      const raw = await this.signer.provider.getBalance(address);
      return {
        token: tokenAddress,
        decimals: 18,
        rawAmount: raw.toString(),
        amount: formatUnits(raw, 18),
      };
    }

    const token = await this.getToken(chainId, tokenAddress);
    const contract = new Contract(
      tokenAddress,
      ['function balanceOf(address owner) view returns (uint256)'],
      this.signer.provider,
    );
    const raw = await contract.balanceOf(address) as bigint;
    return {
      token: tokenAddress,
      decimals: token.decimals,
      rawAmount: raw.toString(),
      amount: formatUnits(raw, token.decimals),
    };
  }

  private resolveRouteOptions(params: BridgeQuoteParams): LiFiResolvedRouteOptions {
    let slippage = params.slippage;
    let order = params.routeOrder;
    let preset = params.preset;
    let maxPriceImpact = params.maxPriceImpact;
    let skipSimulation = params.skipSimulation;
    let swapStepTimingStrategies = params.swapStepTimingStrategies;
    let routeTimingStrategies = params.routeTimingStrategies;

    switch (params.routeStrategy) {
      case 'minimum_slippage':
        slippage ??= 0.005;
        preset ??= 'stablecoin';
        maxPriceImpact ??= 0.05;
        break;
      case 'minimum_execution_time':
        skipSimulation ??= true;
        swapStepTimingStrategies ??= [FAST_RESPONSE_TIMING_STRATEGY];
        routeTimingStrategies ??= [FAST_RESPONSE_TIMING_STRATEGY];
        break;
      case 'fastest_route':
      case 'minimum_completion_time':
        order ??= 'FASTEST';
        break;
      case 'recommended':
      default:
        break;
    }

    return {
      slippage,
      order,
      preset,
      maxPriceImpact,
      skipSimulation,
      swapStepTimingStrategies: this.encodeTimingStrategies(swapStepTimingStrategies),
      routeTimingStrategies: this.encodeTimingStrategies(routeTimingStrategies),
    };
  }

  private encodeTimingStrategies(strategies?: LiFiTimingStrategy[]): string[] | undefined {
    if (!strategies?.length) return undefined;

    return strategies.map((strategy) => {
      const type = strategy.strategy ?? 'minWaitTime';
      return `${type}-${strategy.minWaitTimeMs}-${strategy.startingExpectedResults}-${strategy.reduceEveryMs}`;
    });
  }

  private normalizeEvmQuoteAddress(address: string, chainId: number, field: string): string {
    const value = String(address ?? '').trim();
    const caip10 = value.match(/^eip155:(\d+):(0x[0-9a-fA-F]{40})$/);

    if (caip10) {
      const prefixedChainId = Number(caip10[1]);
      if (prefixedChainId !== chainId) {
        throw new EvalancheError(
          `${field} chain prefix ${prefixedChainId} does not match chain ${chainId}`,
          EvalancheErrorCode.INVALID_PARAMS,
        );
      }
      return caip10[2].toLowerCase();
    }

    if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
      return value.toLowerCase();
    }

    throw new EvalancheError(
      `${field} must be a single EVM address for Li.Fi EVM quote requests`,
      EvalancheErrorCode.INVALID_PARAMS,
    );
  }

  private expectString(value: unknown, field: string): string {
    if (typeof value === 'string' && value.length > 0) return value;
    throw new EvalancheError(
      `Li.Fi payload missing ${field}`,
      EvalancheErrorCode.BRIDGE_QUOTE_FAILED,
    );
  }

  private expectNumber(value: unknown, field: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new EvalancheError(
      `Li.Fi payload missing ${field}`,
      EvalancheErrorCode.BRIDGE_QUOTE_FAILED,
    );
  }

  private readNestedString(value: Record<string, unknown>, path: string[]): string | undefined {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return typeof current === 'string' ? current : undefined;
  }
}
