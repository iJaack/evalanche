import { Evalanche } from '../agent';
import type { EvalancheConfig } from '../agent';
import { IdentityResolver } from '../identity/resolver';
import { ArenaSwapClient } from '../swap/arena';
import { approveAndCall, upgradeProxy } from '../utils/contract-helpers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { getNetworkConfig } from '../utils/networks';
import { getAllChains } from '../utils/chains';
import { NATIVE_TOKEN } from '../bridge/lifi';
import { safeFetch, assertSafeUrl } from '../utils/safe-fetch';
import { CoinGeckoClient } from '../market/coingecko';
import { PolymarketCli, PolymarketClient } from '../polymarket';
import { DiscoveryClient } from '../economy/discovery';
import { AgentServiceHost } from '../economy/service';
import { NegotiationClient } from '../economy/negotiation';
import { SettlementClient } from '../economy/settlement';
import { AgentMemory } from '../economy/memory';
import { InteropIdentityResolver } from '../interop/identity';
import { A2AClient } from '../interop/a2a';
import { A2AServer } from '../interop/a2a-server';
import { createDefaultDappRegistry, resolveDappTarget } from '../defi/dapp-registry';
import type { ChainName } from '../utils/networks';
import { timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

/** MCP tool definition */
interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP JSON-RPC request */
interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** MCP JSON-RPC response */
interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPHTTPOptions {
  port?: number;
  host?: string;
  authToken?: string;
  maxBodyBytes?: number;
}

const DEFAULT_HTTP_PORT = 3402;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_MAX_BODY_BYTES = 1_000_000;
const POLYMARKET_CLOB_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const POLYMARKET_USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYMARKET_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const POLYMARKET_COLLATERAL_SPENDERS = [
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  '0xe2222d279d744050d28e00520010520000310F59',
] as const;
const APPROVE_SELECTOR = '0x095ea7b3';
const UUPS_UPGRADE_TO_AND_CALL_SELECTOR = '0x4f1ef286';

const TOOLS: MCPTool[] = [
  {
    name: 'get_address',
    description: 'Get the agent wallet address',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_balance',
    description: 'Get the native token balance of the agent wallet (or any address) on the current chain',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Address to check (defaults to agent wallet)' },
      },
    },
  },
  {
    name: 'get_holdings',
    description: 'Scan the wallet for liquid holdings across native balances, seeded ERC-20s, DeFi positions, Polymarket positions, and perp venue positions.',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: { type: 'string', description: 'Wallet address override (defaults to agent wallet)' },
        chains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional chain or venue filters (e.g. ["polygon","base","avalanche","hyperliquid"])',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional categories to include: native, token, defi, prediction, perp',
        },
        protocols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional protocol filters (e.g. ["yousd","polymarket","hyperliquid"])',
        },
      },
    },
  },
  {
    name: 'search_registry',
    description: 'Search the universal in-repo holdings registry for protocols, assets, and position sources.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query' },
        chain: { type: 'string', description: 'Optional chain filter' },
        category: { type: 'string', description: 'Optional category filter' },
      },
      required: ['query'],
    },
  },
  {
    name: 'registry_status',
    description: 'Get counts and detector coverage for the universal holdings registry.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_identity',
    description: 'Resolve the ERC-8004 on-chain identity for this agent, including reputation score and trust level',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_agent',
    description: 'Resolve the ERC-8004 on-chain identity for any agent by ID',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agent ID to look up' },
        registry: { type: 'string', description: 'Optional registry address override' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'send_avax',
    description: 'Send native tokens to an address. Value is in human-readable units (e.g. "0.1").',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination address' },
        value: { type: 'string', description: 'Amount in native token (e.g. "0.1")' },
      },
      required: ['to', 'value'],
    },
  },
  {
    name: 'call_contract',
    description: 'Call a contract method (state-changing transaction)',
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: 'Contract address' },
        abi: {
          type: 'array',
          items: { type: 'string' },
          description: 'Human-readable ABI fragments (e.g. ["function transfer(address to, uint256 amount)"])',
        },
        method: { type: 'string', description: 'Method name to call' },
        args: { type: 'array', description: 'Method arguments' },
        value: { type: 'string', description: 'Native token to send with call (optional)' },
      },
      required: ['contract', 'abi', 'method'],
    },
  },
  {
    name: 'sign_message',
    description: 'Sign an arbitrary message with the agent wallet key',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to sign' },
      },
      required: ['message'],
    },
  },
  {
    name: 'pay_and_fetch',
    description: 'Make an x402 payment-gated HTTP request. Automatically handles 402 Payment Required flow.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        maxPayment: { type: 'string', description: 'Maximum willing to pay in native token (e.g. "0.01")' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Additional HTTP headers' },
        body: { type: 'string', description: 'Request body' },
      },
      required: ['url', 'maxPayment'],
    },
  },
  {
    name: 'submit_feedback',
    description: 'Submit on-chain reputation feedback for another agent via ERC-8004',
    inputSchema: {
      type: 'object',
      properties: {
        targetAgentId: { type: 'string', description: 'Target agent ID to rate' },
        taskRef: { type: 'string', description: 'Task reference identifier' },
        score: { type: 'number', description: 'Reputation score (0-100)' },
        metadata: { type: 'object', description: 'Optional metadata to hash into feedback' },
      },
      required: ['targetAgentId', 'taskRef', 'score'],
    },
  },
  {
    name: 'get_network',
    description: 'Get the current network configuration',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_supported_chains',
    description: 'List all supported EVM chains with IDs, names, RPCs, and explorers',
    inputSchema: {
      type: 'object',
      properties: {
        includeTestnets: { type: 'boolean', description: 'Include testnets (default: true)' },
      },
    },
  },
  {
    name: 'get_chain_info',
    description: 'Get detailed info about the current chain or a specified chain',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'Chain ID to look up (defaults to current chain)' },
      },
    },
  },
  {
    name: 'get_bridge_quote',
    description: 'Get a bridge quote for cross-chain token transfer via Li.Fi (does not execute)',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toToken: { type: 'string', description: 'Destination token address (use "native" for native gas token)' },
        fromAmount: { type: 'string', description: 'Amount to send (human-readable, e.g. "0.1")' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
      },
      required: ['fromChainId', 'toChainId', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'get_bridge_routes',
    description: 'Get all available bridge route options for a cross-chain transfer via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toToken: { type: 'string', description: 'Destination token address (use "native" for native gas token)' },
        fromAmount: { type: 'string', description: 'Amount to send (human-readable, e.g. "0.1")' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
      },
      required: ['fromChainId', 'toChainId', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'bridge_tokens',
    description: 'Bridge tokens between chains using Li.Fi (gets quote and executes the transaction)',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toToken: { type: 'string', description: 'Destination token address (use "native" for native gas token)' },
        fromAmount: { type: 'string', description: 'Amount to send (human-readable, e.g. "0.1")' },
        toAddress: { type: 'string', description: 'Receiver address (defaults to agent address)' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
      },
      required: ['fromChainId', 'toChainId', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'fund_destination_gas',
    description: 'Send gas to a destination chain via Gas.zip (cheap cross-chain gas funding)',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        toAddress: { type: 'string', description: 'Recipient address on destination chain (defaults to agent address)' },
        destinationGasAmount: { type: 'string', description: 'Amount of gas to receive on destination (e.g. "0.01")' },
      },
      required: ['fromChainId', 'toChainId'],
    },
  },
  {
    name: 'switch_network',
    description: 'Switch to a different EVM network (returns new network info)',
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          description: 'Network name (e.g. "ethereum", "base", "robinhood", "arbitrum", "optimism", "polygon")',
        },
      },
      required: ['network'],
    },
  },
  {
    name: 'arena_buy',
    description: 'Buy Arena community tokens on Avalanche C-Chain. Spends $ARENA to purchase community tokens via the bonding curve.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'ERC-20 address of the Arena community token to buy' },
        amount: { type: 'string', description: 'Amount of community tokens to buy (human-readable, e.g. "100")' },
        maxArenaSpend: { type: 'string', description: 'Maximum $ARENA willing to spend (human-readable, e.g. "50")' },
      },
      required: ['tokenAddress', 'amount', 'maxArenaSpend'],
    },
  },
  {
    name: 'arena_sell',
    description: 'Sell Arena community tokens on Avalanche C-Chain. Sells community tokens for $ARENA via the bonding curve.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'ERC-20 address of the Arena community token to sell' },
        amount: { type: 'string', description: 'Amount of community tokens to sell (human-readable, e.g. "100")' },
        minArenaReceive: { type: 'string', description: 'Minimum $ARENA to accept (slippage guard, human-readable, e.g. "10")' },
      },
      required: ['tokenAddress', 'amount', 'minArenaReceive'],
    },
  },
  {
    name: 'arena_token_info',
    description: 'Get info about an Arena community token (name, supply, tokenId) by its ERC-20 address',
    inputSchema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'ERC-20 address of the Arena community token' },
      },
      required: ['tokenAddress'],
    },
  },
  {
    name: 'arena_buy_cost',
    description: 'Calculate the $ARENA cost to buy a given amount of an Arena community token (read-only, does not execute)',
    inputSchema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'ERC-20 address of the Arena community token' },
        amount: { type: 'string', description: 'Amount of community tokens to price (human-readable, e.g. "100")' },
      },
      required: ['tokenAddress', 'amount'],
    },
  },
  {
    name: 'approve_and_call',
    description: 'Approve ERC-20 token spending, then execute a follow-up contract call in sequence',
    inputSchema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'ERC-20 token address to approve' },
        spenderAddress: { type: 'string', description: 'Address that receives approval (and call target by default)' },
        amount: { type: 'string', description: 'Token amount in smallest unit (wei for 18-decimal tokens)' },
        contractCallData: { type: 'string', description: 'Hex calldata (0x...) for the follow-up contract call' },
        targetAddress: { type: 'string', description: 'Optional contract call target override (defaults to spenderAddress)' },
        valueWei: { type: 'string', description: 'Optional native token value in wei to send with contract call' },
        gasLimit: { type: 'string', description: 'Optional gas limit for follow-up contract call' },
      },
      required: ['tokenAddress', 'spenderAddress', 'amount', 'contractCallData'],
    },
  },
  {
    name: 'upgrade_proxy',
    description: 'Upgrade a UUPS proxy via upgradeToAndCall(newImplementation, initData)',
    inputSchema: {
      type: 'object',
      properties: {
        proxyAddress: { type: 'string', description: 'UUPS proxy address' },
        newImplementationAddress: { type: 'string', description: 'New implementation contract address' },
        initData: { type: 'string', description: 'Optional initialization calldata (0x...); defaults to 0x' },
      },
      required: ['proxyAddress', 'newImplementationAddress'],
    },
  },
  {
    name: 'dydx_get_markets',
    description: 'List all available dYdX perpetual markets with oracle prices and leverage info',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dydx_has_market',
    description: 'Check whether a specific dYdX perpetual market exists (e.g. AKT-USD)',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Perpetual market ticker (e.g. AKT-USD)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'dydx_get_balance',
    description: 'Get USDC equity balance on the default dYdX subaccount',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dydx_get_positions',
    description: 'Get all open dYdX perpetual positions',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dydx_place_market_order',
    description: 'Place a dYdX market order (BUY/SELL)',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker (e.g. ETH-USD)' },
        side: { type: 'string', description: 'Order side: BUY or SELL' },
        size: { type: 'string', description: 'Order size in base asset units' },
        reduceOnly: { type: 'boolean', description: 'Set to true to only reduce an existing position' },
      },
      required: ['market', 'side', 'size'],
    },
  },
  {
    name: 'dydx_place_limit_order',
    description: 'Place a dYdX limit order',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker (e.g. ETH-USD)' },
        side: { type: 'string', description: 'Order side: BUY or SELL' },
        size: { type: 'string', description: 'Order size in base asset units' },
        price: { type: 'string', description: 'Limit price' },
        timeInForce: { type: 'string', description: 'Time in force: GTT, FOK, or IOC' },
        goodTilSeconds: { type: 'number', description: 'Good-til unix timestamp in seconds' },
        reduceOnly: { type: 'boolean', description: 'Set to true to only reduce position size' },
        postOnly: { type: 'boolean', description: 'Set to true to avoid taker execution' },
      },
      required: ['market', 'side', 'size', 'price'],
    },
  },
  {
    name: 'dydx_cancel_order',
    description: 'Cancel an open dYdX order by encoded orderId from dydx_get_orders',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Encoded order ID from dydx_get_orders' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'dydx_close_position',
    description: 'Close an open dYdX perpetual position with a reduce-only market order',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker to close' },
      },
      required: ['market'],
    },
  },
  {
    name: 'dydx_get_orders',
    description: 'List dYdX subaccount orders (optionally filter by status)',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional order status filter (e.g. OPEN, FILLED, CANCELED)' },
      },
    },
  },
  {
    name: 'hyperliquid_get_markets',
    description: 'List Hyperliquid perpetual markets, including HIP-3 metadata when available',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hyperliquid_get_account_state',
    description: 'Get Hyperliquid account summary for the connected wallet',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hyperliquid_get_positions',
    description: 'Get all open Hyperliquid perpetual positions',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hyperliquid_place_market_order',
    description: 'Place a Hyperliquid market order',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker (e.g. BTC)' },
        side: { type: 'string', description: 'Order side: BUY or SELL' },
        size: { type: 'string', description: 'Order size in base asset units' },
        reduceOnly: { type: 'boolean', description: 'Set to true to only reduce an existing position' },
      },
      required: ['market', 'side', 'size'],
    },
  },
  {
    name: 'hyperliquid_place_limit_order',
    description: 'Place a Hyperliquid limit order',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker (e.g. BTC)' },
        side: { type: 'string', description: 'Order side: BUY or SELL' },
        size: { type: 'string', description: 'Order size in base asset units' },
        price: { type: 'string', description: 'Limit price' },
        timeInForce: { type: 'string', description: 'Time in force: GTT, FOK, or IOC' },
        reduceOnly: { type: 'boolean', description: 'Set to true to only reduce position size' },
        postOnly: { type: 'boolean', description: 'Set to true to avoid taker execution' },
      },
      required: ['market', 'side', 'size', 'price'],
    },
  },
  {
    name: 'hyperliquid_cancel_order',
    description: 'Cancel an open Hyperliquid order by order ID',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Hyperliquid order ID' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'hyperliquid_close_position',
    description: 'Close an open Hyperliquid perpetual position with a reduce-only market order',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Perpetual market ticker to close' },
      },
      required: ['market'],
    },
  },
  {
    name: 'hyperliquid_get_order',
    description: 'Get Hyperliquid order status by order ID',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Hyperliquid order ID' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'hyperliquid_get_orders',
    description: 'List Hyperliquid open orders for the connected wallet',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hyperliquid_get_trades',
    description: 'List recent Hyperliquid fills for the connected wallet',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_perp_market',
    description: 'Search for a perpetual market ticker across all connected perp venues',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Perpetual market ticker to search (e.g. AKT-USD)' },
      },
      required: ['ticker'],
    },
  },
  // Li.Fi cross-chain liquidity SDK tools (v0.8.0)
  {
    name: 'check_bridge_status',
    description: 'Check status of a cross-chain transfer via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        txHash: { type: 'string', description: 'Transaction hash to check' },
        bridge: { type: 'string', description: 'Bridge name (optional)' },
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
      },
      required: ['txHash', 'fromChainId', 'toChainId'],
    },
  },
  {
    name: 'lifi_swap_quote',
    description: 'Get a same-chain swap quote via Li.Fi DEX aggregation (does not execute)',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'Chain ID for the swap' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toToken: { type: 'string', description: 'Destination token address' },
        fromAmount: { type: 'string', description: 'Amount to swap (human-readable, e.g. "1.0")' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
        routeStrategy: { type: 'string', description: 'High-level routing strategy: recommended, minimum_slippage, minimum_execution_time, fastest_route, minimum_completion_time' },
        routeOrder: { type: 'string', description: 'Explicit Li.Fi route ordering override: FASTEST or CHEAPEST' },
        preset: { type: 'string', description: 'Optional Li.Fi preset such as stablecoin' },
        maxPriceImpact: { type: 'number', description: 'Optional max price impact filter passed to Li.Fi' },
        skipSimulation: { type: 'boolean', description: 'Skip Li.Fi simulation to reduce quote latency' },
      },
      required: ['chainId', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'lifi_swap',
    description: 'Execute a same-chain swap via Li.Fi DEX aggregation',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'Chain ID for the swap' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toToken: { type: 'string', description: 'Destination token address' },
        fromAmount: { type: 'string', description: 'Amount to swap (human-readable, e.g. "1.0")' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
        routeStrategy: { type: 'string', description: 'High-level routing strategy: recommended, minimum_slippage, minimum_execution_time, fastest_route, minimum_completion_time' },
        routeOrder: { type: 'string', description: 'Explicit Li.Fi route ordering override: FASTEST or CHEAPEST' },
        preset: { type: 'string', description: 'Optional Li.Fi preset such as stablecoin' },
        maxPriceImpact: { type: 'number', description: 'Optional max price impact filter passed to Li.Fi' },
        skipSimulation: { type: 'boolean', description: 'Skip Li.Fi simulation to reduce quote latency' },
      },
      required: ['chainId', 'fromToken', 'toToken', 'fromAmount'],
    },
  },
  {
    name: 'lifi_get_tokens',
    description: 'List all known tokens on specified chains via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        chainIds: { type: 'array', items: { type: 'number' }, description: 'Chain IDs to get tokens for' },
      },
      required: ['chainIds'],
    },
  },
  {
    name: 'lifi_get_token',
    description: 'Get specific token info (name, symbol, decimals, price) via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'Chain ID' },
        tokenAddress: { type: 'string', description: 'Token contract address' },
      },
      required: ['chainId', 'tokenAddress'],
    },
  },
  {
    name: 'lifi_get_chains',
    description: 'List all chains supported by Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        chainTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by chain types (e.g. ["EVM"])' },
      },
    },
  },
  {
    name: 'lifi_get_tools',
    description: 'List all available bridges and DEX aggregators on Li.Fi',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lifi_gas_prices',
    description: 'Get gas prices across all supported chains via Li.Fi',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'lifi_gas_suggestion',
    description: 'Get gas price suggestion for a specific chain via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: { type: 'number', description: 'Chain ID to get gas suggestion for' },
      },
      required: ['chainId'],
    },
  },
  {
    name: 'lifi_get_connections',
    description: 'Get possible token transfer connections between chains via Li.Fi',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address (optional filter)' },
        toToken: { type: 'string', description: 'Destination token address (optional filter)' },
      },
      required: ['fromChainId', 'toChainId'],
    },
  },
  {
    name: 'lifi_compose',
    description: 'Execute a cross-chain DeFi Composer operation via Li.Fi — bridge + deposit into vault/stake/lend in one transaction. Supports Morpho, Aave V3, Euler, Pendle, Lido wstETH, EtherFi, and more.',
    inputSchema: {
      type: 'object',
      properties: {
        fromChainId: { type: 'number', description: 'Source chain ID' },
        toChainId: { type: 'number', description: 'Destination chain ID' },
        fromToken: { type: 'string', description: 'Source token address (use "native" for native gas token)' },
        toVaultToken: { type: 'string', description: 'Vault/staking token address on destination chain' },
        fromAmount: { type: 'string', description: 'Amount to send (human-readable, e.g. "1.0")' },
        slippage: { type: 'number', description: 'Slippage tolerance as decimal (default: 0.03 = 3%)' },
        routeStrategy: { type: 'string', description: 'High-level routing strategy: recommended, minimum_slippage, minimum_execution_time, fastest_route, minimum_completion_time' },
        routeOrder: { type: 'string', description: 'Explicit Li.Fi route ordering override: FASTEST or CHEAPEST' },
        preset: { type: 'string', description: 'Optional Li.Fi preset such as stablecoin' },
        maxPriceImpact: { type: 'number', description: 'Optional max price impact filter passed to Li.Fi' },
        skipSimulation: { type: 'boolean', description: 'Skip Li.Fi simulation to reduce quote latency' },
      },
      required: ['fromChainId', 'toChainId', 'fromToken', 'toVaultToken', 'fromAmount'],
    },
  },
  // Platform CLI tools (v0.6.0) — require platform-cli binary
  {
    name: 'platform_cli_available',
    description: 'Check if the platform-cli binary is installed and available',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'subnet_create',
    description: 'Create a new Avalanche subnet (requires platform-cli binary)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'subnet_convert_l1',
    description: 'Convert a subnet to an L1 blockchain (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        subnetId: { type: 'string', description: 'Subnet ID to convert' },
        chainId: { type: 'string', description: 'Chain ID where validator manager lives' },
        validators: { type: 'string', description: 'Comma-separated validator addresses (auto-fetches NodeID + BLS)' },
        managerAddress: { type: 'string', description: 'Validator manager contract address (hex)' },
        mockValidator: { type: 'boolean', description: 'Use mock validator for testing' },
      },
      required: ['subnetId', 'chainId'],
    },
  },
  {
    name: 'subnet_transfer_ownership',
    description: 'Transfer ownership of a subnet (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        subnetId: { type: 'string', description: 'Subnet ID' },
        newOwner: { type: 'string', description: 'New owner address' },
      },
      required: ['subnetId', 'newOwner'],
    },
  },
  {
    name: 'add_validator',
    description: 'Add a validator to the Avalanche Primary Network with BLS keys (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node ID (e.g. NodeID-...)' },
        stakeAvax: { type: 'number', description: 'Stake amount in AVAX (min 2000)' },
        durationHours: { type: 'number', description: 'Duration in hours (min 336 = 14 days)' },
        delegationFee: { type: 'number', description: 'Delegation fee (0.02 = 2%)' },
        blsPublicKey: { type: 'string', description: 'BLS public key (hex)' },
        blsPop: { type: 'string', description: 'BLS proof of possession (hex)' },
        nodeEndpoint: { type: 'string', description: 'Node endpoint to auto-fetch BLS keys' },
      },
      required: ['nodeId', 'stakeAvax'],
    },
  },
  {
    name: 'l1_register_validator',
    description: 'Register a new L1 validator (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        balanceAvax: { type: 'number', description: 'Initial balance in AVAX for continuous fees' },
        pop: { type: 'string', description: 'BLS proof of possession (hex)' },
        message: { type: 'string', description: 'Warp message authorizing the validator (hex)' },
      },
      required: ['balanceAvax', 'pop', 'message'],
    },
  },
  {
    name: 'l1_add_balance',
    description: 'Add balance to an L1 validator (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        validationId: { type: 'string', description: 'Validation ID' },
        balanceAvax: { type: 'number', description: 'Balance to add in AVAX' },
      },
      required: ['validationId', 'balanceAvax'],
    },
  },
  {
    name: 'l1_disable_validator',
    description: 'Disable an L1 validator (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        validationId: { type: 'string', description: 'Validation ID to disable' },
      },
      required: ['validationId'],
    },
  },
  {
    name: 'node_info',
    description: 'Get node info (NodeID + BLS keys) from a running avalanchego node (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: 'Node IP address or endpoint' },
      },
      required: ['ip'],
    },
  },
  {
    name: 'pchain_send',
    description: 'Send AVAX on P-Chain to another P-Chain address (requires platform-cli binary)',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination P-Chain address' },
        amountAvax: { type: 'number', description: 'Amount in AVAX' },
      },
      required: ['to', 'amountAvax'],
    },
  },
  // Economy tools (v1.0.0)
  {
    name: 'get_budget',
    description: 'Get the current spending budget status: remaining hourly/daily limits, transaction counts, and active policy. Returns null if no policy is set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_policy',
    description: 'Set or update the agent spending policy. Controls per-transaction limits, hourly/daily budgets, contract allowlists, and chain restrictions. Removal requires remove=true and confirm="remove".',
    inputSchema: {
      type: 'object',
      properties: {
        maxPerTransaction: { type: 'string', description: 'Max native token value per tx in wei (e.g. "100000000000000000" = 0.1 ETH)' },
        maxPerHour: { type: 'string', description: 'Max total spend in wei within a rolling 1-hour window' },
        maxPerDay: { type: 'string', description: 'Max total spend in wei within a rolling 24-hour window' },
        allowlistedChains: { type: 'array', items: { type: 'number' }, description: 'Array of permitted chain IDs (e.g. [8453, 43114])' },
        allowlistedContracts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string' },
              selectors: { type: 'array', items: { type: 'string' } },
            },
            required: ['address'],
          },
          description: 'Array of permitted contract addresses with optional function selectors',
        },
        simulateBeforeSend: { type: 'boolean', description: 'If true, simulate every tx before sending (default: false)' },
        dryRun: { type: 'boolean', description: 'If true, log violations but do not block (default: false)' },
        remove: { type: 'boolean', description: 'Set true to remove the current policy' },
        confirm: { type: 'string', description: 'Must be "remove" when remove is true' },
      },
    },
  },
  {
    name: 'simulate_tx',
    description: 'Simulate a transaction without broadcasting it. Runs eth_call to detect reverts and estimate gas before spending anything.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target address' },
        value: { type: 'string', description: 'Value in human-readable units (e.g. "0.1" for 0.1 ETH/AVAX)' },
        data: { type: 'string', description: 'Calldata hex (0x...)' },
      },
      required: ['to'],
    },
  },
  {
    name: 'register_service',
    description: 'Register a service this agent offers, making it discoverable by other agents. Services are identified by capability name.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Service name (e.g. "code-audit", "price-feed", "token-analysis")' },
        description: { type: 'string', description: 'Short description of what the service does' },
        endpoint: { type: 'string', description: 'x402-compatible URL where the service is available' },
        pricePerCall: { type: 'string', description: 'Price per call in wei (native token)' },
        chainId: { type: 'number', description: 'Chain ID where payments are accepted' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for search filtering' },
      },
      required: ['capability', 'description', 'endpoint', 'pricePerCall', 'chainId'],
    },
  },
  {
    name: 'discover_agents',
    description: 'Search for agents offering services matching your criteria. Filter by capability, reputation, price, chain, or tags.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Capability to search for (substring match, e.g. "audit")' },
        minReputation: { type: 'number', description: 'Minimum reputation score (0-100)' },
        maxPrice: { type: 'string', description: 'Maximum price per call in wei' },
        chainIds: { type: 'array', items: { type: 'number' }, description: 'Only return services on these chains' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Required tags (all must match)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
    },
  },
  {
    name: 'resolve_agent_profile',
    description: 'Get the full profile of an agent: on-chain ERC-8004 identity, reputation score, trust level, and registered services.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ERC-8004 agent ID to resolve' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'serve_endpoint',
    description: 'Register a payment-gated endpoint that other agents can pay to use. This agent earns revenue when callers pay the x402 fee.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'URL path (e.g. "/audit", "/price-feed")' },
        price: { type: 'string', description: 'Price per call in human-readable units (e.g. "0.01")' },
        currency: { type: 'string', description: 'Currency symbol (e.g. "ETH", "AVAX")' },
        chainId: { type: 'number', description: 'Chain ID where payments are accepted' },
        responseTemplate: { type: 'string', description: 'Static response content to serve (for simple endpoints)' },
      },
      required: ['path', 'price', 'currency', 'chainId'],
    },
  },
  {
    name: 'get_revenue',
    description: 'Get revenue summary: total paid requests received and breakdown by endpoint.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_services',
    description: 'List all active payment-gated endpoints this agent is serving.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Phase 4: Negotiation & Settlement ──
  {
    name: 'negotiate_task',
    description: 'Create, accept, counter, or reject a task negotiation proposal between agents.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform: "propose", "accept", "counter", "reject"' },
        proposalId: { type: 'string', description: 'Proposal ID (required for accept/counter/reject)' },
        fromAgentId: { type: 'string', description: 'Proposing agent ID (required for propose)' },
        toAgentId: { type: 'string', description: 'Target agent ID (required for propose)' },
        toAddress: { type: 'string', description: 'Settlement address for the target agent (recommended for propose)' },
        task: { type: 'string', description: 'Task description (required for propose)' },
        price: { type: 'string', description: 'Proposed price in wei (required for propose)' },
        chainId: { type: 'number', description: 'Chain ID for settlement (required for propose)' },
        counterPrice: { type: 'string', description: 'Counter-offer price in wei (required for counter)' },
        ttlMs: { type: 'number', description: 'Time-to-live in milliseconds (optional, default 1 hour)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'settle_payment',
    description: 'Settle an accepted negotiation by sending payment and optionally submitting a reputation score.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'The accepted proposal to settle' },
        recipientAddress: { type: 'string', description: 'Recipient address if the proposal stores only an agent ID' },
        reputationScore: { type: 'number', description: 'Reputation score (0-100) to submit for the counterparty' },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'get_agreements',
    description: 'List negotiation proposals, optionally filtered by status or agent.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, accepted, countered, rejected, expired, settled' },
        agentId: { type: 'string', description: 'Filter by agent ID (matches from or to)' },
        proposalId: { type: 'string', description: 'Get a single proposal by ID' },
      },
    },
  },
  // ── Phase 5: Persistent Memory ──
  {
    name: 'record_interaction',
    description: 'Record an agent interaction (payment, negotiation, service call, reputation) in persistent memory.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Interaction type: payment_sent, payment_received, negotiation_proposed, negotiation_accepted, negotiation_rejected, negotiation_countered, service_called, reputation_submitted' },
        counterpartyId: { type: 'string', description: 'The other agent involved' },
        amount: { type: 'string', description: 'Amount in wei (for payments)' },
        chainId: { type: 'number', description: 'Chain ID where this occurred' },
        txHash: { type: 'string', description: 'Transaction hash (for on-chain events)' },
        reputationScore: { type: 'number', description: 'Reputation score given (0-100)' },
        metadata: { type: 'object', description: 'Free-form metadata (task, capability, etc.)' },
      },
      required: ['type', 'counterpartyId'],
    },
  },
  {
    name: 'get_transaction_history',
    description: 'Query past agent interactions with optional filters (type, counterparty, time range, chain).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by interaction type' },
        counterpartyId: { type: 'string', description: 'Filter by counterparty agent ID' },
        since: { type: 'number', description: 'Only interactions after this Unix timestamp (ms)' },
        until: { type: 'number', description: 'Only interactions before this Unix timestamp (ms)' },
        chainId: { type: 'number', description: 'Only interactions on this chain' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
      },
    },
  },
  {
    name: 'get_relationships',
    description: 'Get aggregated relationship data for all known agents or a specific agent, including trust scores.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Get relationship with a specific agent. Omit for all relationships.' },
        capability: { type: 'string', description: 'Get preferred agents for a capability, ranked by trust score.' },
        limit: { type: 'number', description: 'Max results when querying by capability (default: 5)' },
      },
    },
  },
  // ── Phase 7: Interop — ERC-8004 Identity Resolution ──
  {
    name: 'resolve_agent_registration',
    description: 'Resolve the full ERC-8004 agent registration file from on-chain agentURI. Returns services, wallet, trust modes, and activity status.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent token ID to resolve' },
        agentRegistry: { type: 'string', description: 'Optional registry contract address override' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_agent_services',
    description: 'List all service endpoints advertised by an agent in their ERC-8004 registration file.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent token ID' },
        agentRegistry: { type: 'string', description: 'Optional registry contract address override' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_agent_wallet',
    description: 'Get the payment wallet address for an agent from on-chain metadata or registration file.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent token ID' },
        agentRegistry: { type: 'string', description: 'Optional registry contract address override' },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'verify_agent_endpoint',
    description: 'Verify that an agent endpoint has a valid domain binding via .well-known/agent-registration.json.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent token ID' },
        endpoint: { type: 'string', description: 'Endpoint URL to verify' },
        agentRegistry: { type: 'string', description: 'Optional registry contract address override' },
      },
      required: ['agentId', 'endpoint'],
    },
  },
  {
    name: 'resolve_by_wallet',
    description: 'Find an agent ID from a wallet address by querying on-chain Transfer events.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address to look up' },
        agentRegistry: { type: 'string', description: 'Optional registry contract address override' },
      },
      required: ['address'],
    },
  },

  // ── DeFi: Liquid Staking ──────────────────────────────────────────────
  {
    name: 'savax_stake_quote',
    description: 'Get a quote for staking AVAX → sAVAX on Benqi (Avalanche). Returns expected shares and exchange rate.',
    inputSchema: {
      type: 'object',
      properties: {
        amountAvax: { type: 'string', description: 'Amount of AVAX to stake (human-readable, e.g. "10")' },
        network: { type: 'string', description: 'Optional network override. Canonical route is Avalanche.' },
      },
      required: ['amountAvax'],
    },
  },
  {
    name: 'savax_stake',
    description: 'Stake AVAX → sAVAX on Benqi (Avalanche). Sends AVAX and receives sAVAX liquid staking tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        amountAvax: { type: 'string', description: 'Amount of AVAX to stake (human-readable)' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%)' },
        network: { type: 'string', description: 'Optional network override. Canonical route is Avalanche.' },
      },
      required: ['amountAvax'],
    },
  },
  {
    name: 'savax_unstake_quote',
    description: 'Get a quote for unstaking sAVAX → AVAX. Checks instant pool availability.',
    inputSchema: {
      type: 'object',
      properties: {
        shares: { type: 'string', description: 'Amount of sAVAX to redeem (human-readable)' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%)' },
        network: { type: 'string', description: 'Optional network override. Canonical route is Avalanche.' },
      },
      required: ['shares'],
    },
  },
  {
    name: 'savax_unstake',
    description: 'Unstake sAVAX → AVAX on Benqi. Uses instant redeem if pool is sufficient, otherwise delayed redeem.',
    inputSchema: {
      type: 'object',
      properties: {
        shares: { type: 'string', description: 'Amount of sAVAX to redeem (human-readable)' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%)' },
        forceDelayed: { type: 'boolean', description: 'Force delayed unstake even if instant is available (default: false)' },
        network: { type: 'string', description: 'Optional network override. Canonical route is Avalanche.' },
      },
      required: ['shares'],
    },
  },

  // ── DeFi: EIP-4626 Vaults ────────────────────────────────────────────
  {
    name: 'vault_info',
    description: 'Get metadata for an EIP-4626 vault (name, asset, totalAssets).',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address' },
        network: { type: 'string', description: 'Optional network override. Interoperable addresses like 0x...@base are also supported.' },
      },
      required: ['vaultAddress'],
    },
  },
  {
    name: 'vault_deposit_quote',
    description: 'Preview how many vault shares a deposit would mint.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address' },
        assetAmount: { type: 'string', description: 'Amount of underlying asset (human-readable)' },
        assetDecimals: { type: 'number', description: 'Decimals of the underlying asset (default: 6)' },
        network: { type: 'string', description: 'Optional network override. Interoperable addresses like 0x...@base are also supported.' },
      },
      required: ['vaultAddress', 'assetAmount'],
    },
  },
  {
    name: 'vault_deposit',
    description: 'Approve and deposit assets into an EIP-4626 vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address' },
        assetAmount: { type: 'string', description: 'Amount of underlying asset to deposit (human-readable)' },
        assetDecimals: { type: 'number', description: 'Decimals of the underlying asset (default: 6)' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%)' },
        network: { type: 'string', description: 'Optional network override. Interoperable addresses like 0x...@base are also supported.' },
      },
      required: ['vaultAddress', 'assetAmount'],
    },
  },
  {
    name: 'vault_withdraw_quote',
    description: 'Preview how many assets would be returned for redeeming vault shares.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address' },
        shareAmount: { type: 'string', description: 'Amount of vault shares to redeem (human-readable)' },
        shareDecimals: { type: 'number', description: 'Decimals of the vault shares (default: 6)' },
        network: { type: 'string', description: 'Optional network override. Interoperable addresses like 0x...@base are also supported.' },
      },
      required: ['vaultAddress', 'shareAmount'],
    },
  },
  {
    name: 'vault_withdraw',
    description: 'Redeem vault shares for underlying assets from an EIP-4626 vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vaultAddress: { type: 'string', description: 'Vault contract address' },
        shareAmount: { type: 'string', description: 'Amount of vault shares to redeem (human-readable)' },
        shareDecimals: { type: 'number', description: 'Decimals of the vault shares (default: 6)' },
        slippageBps: { type: 'number', description: 'Slippage tolerance in basis points (default: 100 = 1%)' },
        network: { type: 'string', description: 'Optional network override. Interoperable addresses like 0x...@base are also supported.' },
      },
      required: ['vaultAddress', 'shareAmount'],
    },
  },
  // ─── CoinGecko Market Data ───
  {
    name: 'cg_price',
    description: 'Get current price of one or more coins via CoinGecko CLI',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'string', description: 'Comma-separated CoinGecko coin IDs (e.g. "bitcoin,ethereum")' },
        symbols: { type: 'string', description: 'Comma-separated symbols (e.g. "btc,eth")' },
        vs: { type: 'string', description: 'Quote currency (default: usd)' },
      },
    },
  },
  {
    name: 'cg_trending',
    description: 'Get trending coins, NFTs, and categories from CoinGecko',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cg_top_movers',
    description: 'Get top gainers and losers from CoinGecko',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'string', description: 'Time duration (e.g. "1h", "24h", "7d", "30d")' },
        losers: { type: 'boolean', description: 'Show losers instead of gainers' },
        topCoins: { type: 'string', description: 'Filter by market cap rank (e.g. "300", "1000")' },
      },
    },
  },
  {
    name: 'cg_markets',
    description: 'Get top coins by market cap from CoinGecko',
    inputSchema: {
      type: 'object',
      properties: {
        total: { type: 'number', description: 'Number of coins to return (default: 10)' },
        category: { type: 'string', description: 'Filter by category (e.g. "defi", "layer-1")' },
        order: { type: 'string', description: 'Sort order (e.g. "market_cap_desc", "volume_desc")' },
        vs: { type: 'string', description: 'Quote currency (default: usd)' },
      },
    },
  },
  {
    name: 'cg_search',
    description: 'Search for coins on CoinGecko by name or symbol',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cg_history',
    description: 'Get historical price data for a coin from CoinGecko',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'CoinGecko coin ID (e.g. "bitcoin")' },
        days: { type: 'string', description: 'Number of days (e.g. "7", "30", "365", "max")' },
        date: { type: 'string', description: 'Specific date (dd-mm-yyyy)' },
        from: { type: 'string', description: 'Start timestamp (Unix seconds)' },
        to: { type: 'string', description: 'End timestamp (Unix seconds)' },
        interval: { type: 'string', description: 'Data interval (e.g. "daily")' },
        vs: { type: 'string', description: 'Quote currency (default: usd)' },
        ohlc: { type: 'boolean', description: 'Return OHLC candle data' },
      },
      required: ['id'],
    },
  },
  {
    name: 'cg_status',
    description: 'Check CoinGecko CLI status, API key configuration, and tier',
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── Polymarket ───
  {
    name: 'pm_search',
    description: 'Search active Polymarket prediction markets by keyword',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "bitcoin", "election")' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pm_market',
    description: 'Get details for a specific Polymarket market by condition ID',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Market condition ID' },
      },
      required: ['conditionId'],
    },
  },
  {
    name: 'pm_positions',
    description: 'Get on-chain verified Polymarket positions for a wallet',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: { type: 'string', description: 'Wallet address (defaults to agent address)' },
      },
    },
  },
  {
    name: 'pm_orderbook',
    description: 'Get the order book for a Polymarket outcome token. Get the token ID from pm_market first.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Outcome token ID (get from pm_market)' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'pm_balances',
    description: 'Get Polymarket collateral and venue balance state for the authenticated wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Optional outcome token ID to include conditional balance/allowance checks' },
      },
    },
  },
  {
    name: 'pm_order',
    description: 'Get venue truth for a Polymarket order by order ID, including a reconciliation snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Polymarket order ID' },
        tokenId: { type: 'string', description: 'Optional outcome token ID for tighter reconciliation' },
        conditionId: { type: 'string', description: 'Optional market condition ID used with outcome to resolve tokenId' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome used with conditionId to resolve a token ID' },
        walletAddress: { type: 'string', description: 'Optional wallet override for position reconciliation' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'pm_cancel_order',
    description: 'Cancel an open Polymarket order by order ID and verify the resulting venue state.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Polymarket order ID' },
        tokenId: { type: 'string', description: 'Optional outcome token ID for tighter reconciliation' },
        conditionId: { type: 'string', description: 'Optional market condition ID used with outcome to resolve tokenId' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome used with conditionId to resolve a token ID' },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'pm_open_orders',
    description: 'List Polymarket open orders, optionally filtered to a market outcome token.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Outcome token ID to filter by' },
        conditionId: { type: 'string', description: 'Market condition ID (resolved with outcome into a token ID)' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome used with conditionId to resolve a token ID' },
      },
    },
  },
  {
    name: 'pm_trades',
    description: 'List Polymarket venue trades, optionally filtered to a market outcome token.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Outcome token ID to filter by' },
        conditionId: { type: 'string', description: 'Market condition ID (resolved with outcome into a token ID)' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome used with conditionId to resolve a token ID' },
      },
    },
  },
  {
    name: 'pm_deposit',
    description: 'Deposit USDC into the Polymarket CLOB contract to enable trading. The CLOB requires USDC to be deposited (via registerCollateral) before buy/sell orders can execute. Use pm_balances to check your CLOB collateral balance.',
    inputSchema: {
      type: 'object',
      properties: {
        amountUSDC: { type: 'string', description: 'Amount of USDC to deposit into the CLOB (e.g. "10.50")' },
        skipApproveIfAllowanceAtLeast: { type: 'number', description: 'Skip ERC-20 approve step if existing on-chain allowance is >= this amount. Default: 0.' },
      },
      required: ['amountUSDC'],
    },
  },
  {
    name: 'pm_withdraw',
    description: 'Withdraw Polymarket wallet USDC.e from Polygon to another chain/token through the official Polymarket bridge flow.',
    inputSchema: {
      type: 'object',
      properties: {
        amountUSDC: { type: 'string', description: 'Amount of Polygon USDC.e to withdraw from the Polymarket wallet (e.g. "10")' },
        toChainId: { type: 'string', description: 'Destination chain ID (e.g. "1" Ethereum, "8453" Base, "1151111081099710" Solana)' },
        toTokenAddress: { type: 'string', description: 'Destination token contract address or mint supported by the Polymarket bridge' },
        recipientAddr: { type: 'string', description: 'Destination wallet address that should receive the bridged funds' },
      },
      required: ['amountUSDC', 'toChainId', 'toTokenAddress', 'recipientAddr'],
    },
  },
  {
    name: 'pm_approve',
    description: 'Approve USDC spending for Polymarket exchange on Polygon',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'USDC amount to approve (e.g. "100")' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'pm_preflight',
    description: 'Run deterministic Polymarket execution preflight checks before attempting a write.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['buy', 'sell', 'limit_sell'], description: 'Execution path to preflight' },
        conditionId: { type: 'string', description: 'Market condition ID' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to trade' },
        amountUSDC: { type: 'string', description: 'USDC amount for buy or immediate sell flows' },
        orderType: { type: 'string', enum: ['market', 'limit'], description: 'Buy order type (default: market)' },
        limitPrice: { type: 'number', description: 'Limit price for buy preflight' },
        price: { type: 'number', description: 'Limit price for limit sell preflight' },
        shares: { type: 'string', description: 'Outcome shares for limit sell preflight' },
        maxSlippagePct: { type: 'number', description: 'Maximum slippage percent for immediate sell preflight' },
        postOnly: { type: 'boolean', description: 'Whether limit sell should only rest on the book (default: true)' },
      },
      required: ['action', 'conditionId', 'outcome'],
    },
  },
  {
    name: 'pm_buy',
    description: 'Buy outcome shares on a Polymarket market. Requires USDC on Polygon and MATIC for gas.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Market condition ID' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to buy' },
        amountUSDC: { type: 'string', description: 'USDC amount to spend (e.g. "10")' },
        orderType: { type: 'string', enum: ['market', 'limit'], description: 'market = fill at best ask; limit = GTC maker order at limitPrice (default: market)' },
        limitPrice: { type: 'number', description: 'Price per share for limit orders (0-1, e.g. 0.885). Required if orderType=limit.' },
        maxSlippagePct: { type: 'number', description: 'Max slippage % for market orders (default: 1)' },
      },
      required: ['conditionId', 'outcome', 'amountUSDC'],
    },
  },
  {
    name: 'pm_sell',
    description: 'Sell outcome shares on a Polymarket market. Requires outcome tokens on Polygon and MATIC for gas. Looks up best bid to convert amountUSDC → token size.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Market condition ID' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to sell' },
        amountUSDC: { type: 'string', description: 'USDC proceeds target — size is calculated from current best bid (e.g. "10")' },
        maxSlippagePct: { type: 'number', description: 'Max slippage % for market orders (default: 1)' },
      },
      required: ['conditionId', 'outcome', 'amountUSDC'],
    },
  },
  {
    name: 'pm_limit_sell',
    description: 'Post a GTC (Good-Till-Cancel) limit SELL order on a Polymarket outcome. Use this when you want an explicit resting limit order instead of an immediate slippage-protected sell.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Market condition ID' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome to sell' },
        price: { type: 'number', description: 'Limit price per share (0-1, e.g. 0.50 for $0.50)' },
        shares: { type: 'string', description: 'Number of outcome tokens to sell' },
        postOnly: { type: 'boolean', description: 'If true, order only posts to book and does not take liquidity (default: true)' },
      },
      required: ['conditionId', 'outcome', 'price', 'shares'],
    },
  },
  {
    name: 'pm_reconcile',
    description: 'Reconcile Polymarket local assumptions against venue truth using orders, trades, balances, and positions.',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: { type: 'string', description: 'Optional wallet override for positions reconciliation' },
        orderId: { type: 'string', description: 'Optional order ID to verify' },
        conditionId: { type: 'string', description: 'Optional market condition ID' },
        outcome: { type: 'string', enum: ['YES', 'NO'], description: 'Outcome used with conditionId to resolve a token ID' },
        tokenId: { type: 'string', description: 'Optional outcome token ID' },
      },
    },
  },
  {
    name: 'pm_redeem',
    description: 'Redeem winning positions from a resolved Polymarket market for USDC',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Condition ID of resolved market' },
      },
      required: ['conditionId'],

    },
  },
  // ── Phase 8: A2A Protocol ──
  {
    name: 'fetch_agent_card',
    description: 'Fetch an A2A agent card from a URL or resolve one from an ERC-8004 agent ID. Returns agent name, skills, capabilities, and authentication requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the A2A agent (fetches .well-known/agent-card.json)' },
        agentId: { type: 'string', description: 'ERC-8004 agent ID to resolve (alternative to url)' },
      },
    },
  },
  {
    name: 'a2a_list_skills',
    description: 'List skills available from an A2A agent card. Returns skill IDs, names, descriptions, tags, and supported modalities.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the A2A agent' },
        agentId: { type: 'string', description: 'ERC-8004 agent ID (alternative to url)' },
      },
    },
  },
  {
    name: 'a2a_submit_task',
    description: 'Submit a task to an A2A-compliant agent. Invokes a specific skill with input text and returns the task ID and initial status.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the A2A agent' },
        skillId: { type: 'string', description: 'Skill ID to invoke' },
        input: { type: 'string', description: 'Input text or prompt for the task' },
        auth: { type: 'string', description: 'Optional authorization header value (e.g., Bearer token)' },
      },
      required: ['url', 'skillId', 'input'],
    },
  },
  {
    name: 'a2a_get_task',
    description: 'Get the current status, messages, and artifacts of an A2A task.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the A2A agent' },
        taskId: { type: 'string', description: 'Task ID to check' },
        auth: { type: 'string', description: 'Optional authorization header value' },
      },
      required: ['url', 'taskId'],
    },
  },
  {
    name: 'a2a_cancel_task',
    description: 'Cancel an in-progress A2A task.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the A2A agent' },
        taskId: { type: 'string', description: 'Task ID to cancel' },
        auth: { type: 'string', description: 'Optional authorization header value' },
      },
      required: ['url', 'taskId'],
    },
  },
  {
    name: 'a2a_serve',
    description: 'Start a local A2A server and register a skill backed by a real Evalanche capability. The skill will be listed in the agent card and can receive tasks from other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'Unique skill identifier' },
        name: { type: 'string', description: 'Human-readable skill name' },
        description: { type: 'string', description: 'What this skill does' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        capability: { type: 'string', description: 'Evalanche capability to bind: "pay_and_fetch", "resolve_identity", "discover_agents", "negotiate_task", "sign_message", or a custom registered service path' },
      },
      required: ['name', 'description'],
    },
  },
];

/**
 * Evalanche MCP Server — exposes agent wallet capabilities as MCP tools.
 *
 * Supports both stdio (JSON-RPC over stdin/stdout) and HTTP transport.
 */
export class EvalancheMCPServer {
  private agent: Evalanche;
  private config: EvalancheConfig;
  private discovery: DiscoveryClient;
  private serviceHost: AgentServiceHost;
  private negotiation: NegotiationClient;
  private settlement: SettlementClient;
  private memory: AgentMemory;
  private interopResolver: InteropIdentityResolver;
  private a2aClient: A2AClient;
  private a2aServer: A2AServer | null = null;
  private coingecko: CoinGeckoClient;
  private readonly dappRegistry = createDefaultDappRegistry();
  private polymarket: PolymarketClient | null = null;
  private polymarketCli: PolymarketCli;
  private authedClobClient: any = null;


  constructor(config: EvalancheConfig) {
    this.config = config;
    this.agent = new Evalanche(config);
    this.discovery = new DiscoveryClient(this.agent.provider);
    this.serviceHost = new AgentServiceHost(this.agent.address);
    this.negotiation = new NegotiationClient();
    this.settlement = new SettlementClient(this.agent.wallet, this.negotiation);
    this.memory = new AgentMemory(); // in-memory by default; can be swapped for file-backed
    this.interopResolver = new InteropIdentityResolver(this.agent.provider);
    this.a2aClient = new A2AClient({ identity: this.interopResolver });
    this.coingecko = new CoinGeckoClient();
    this.polymarketCli = new PolymarketCli({ privateKey: this.agent.wallet.privateKey });
  }

  private rebindAgentState(): void {
    this.discovery = new DiscoveryClient(this.agent.provider);
    this.settlement = new SettlementClient(this.agent.wallet, this.negotiation);
    this.interopResolver = new InteropIdentityResolver(this.agent.provider);
    this.a2aClient = new A2AClient({ identity: this.interopResolver });
    this.polymarket = null;
    this.polymarketCli = new PolymarketCli({ privateKey: this.agent.wallet.privateKey });
    this.authedClobClient = null;
  }

  /**
   * Build a real A2A skill handler that dispatches to Evalanche capabilities.
   *
   * Supported capabilities:
   * - "pay_and_fetch"    → x402 payment-gated HTTP request
   * - "resolve_identity" → ERC-8004 on-chain identity resolution
   * - "discover_agents"  → search for agents by capability
   * - "negotiate_task"   → create a negotiation proposal
   * - "sign_message"     → sign a message with the agent wallet
   *
   * If no capability is specified, the handler returns an error describing
   * available capabilities (no silent stub).
   */
  private buildA2ASkillHandler(capability?: string): import('../interop/a2a-server').SkillHandler {
    const agent = this.agent;
    const discovery = this.discovery;
    const interopResolver = this.interopResolver;
    const negotiation = this.negotiation;

    switch (capability) {
      case 'pay_and_fetch':
        return async (input: string, metadata?: Record<string, unknown>) => {
          const url = input.trim();
          const maxPayment = (metadata?.maxPayment as string) ?? '0.01';
          const result = await agent.payAndFetch(url, { maxPayment });
          return { text: JSON.stringify(result) };
        };

      case 'resolve_identity':
        return async (input: string) => {
          const agentId = input.trim();
          const registration = await interopResolver.resolveAgent(agentId);
          return { text: JSON.stringify(registration, null, 2) };
        };

      case 'discover_agents':
        return async (input: string) => {
          const services = await discovery.search({ capability: input.trim() });
          return { text: JSON.stringify({ count: services.length, services }, null, 2) };
        };

      case 'negotiate_task':
        return async (input: string, metadata?: Record<string, unknown>) => {
          const toAgentId = metadata?.toAgentId as string | undefined;
          if (!toAgentId) {
            throw new EvalancheError(
              'negotiate_task requires metadata.toAgentId — the target agent ID to negotiate with',
              EvalancheErrorCode.A2A_ERROR,
            );
          }
          const proposalId = negotiation.propose({
            fromAgentId: (metadata?.fromAgentId as string) ?? agent.address,
            toAgentId,
            task: input,
            price: (metadata?.price as string) ?? '0',
            chainId: (metadata?.chainId as number) ?? 43114,
          });
          return { text: JSON.stringify({ proposalId, status: 'pending' }) };
        };

      case 'sign_message':
        return async (input: string) => {
          const signature = await agent.wallet.signMessage(input);
          return { text: JSON.stringify({ message: input, signature, signer: agent.address }) };
        };

      default:
        // No silent stub — explicitly fail with actionable guidance
        return async () => {
          const supported = ['pay_and_fetch', 'resolve_identity', 'discover_agents', 'negotiate_task', 'sign_message'];
          throw new EvalancheError(
            `No capability bound to this skill. Specify one of: ${supported.join(', ')}`,
            EvalancheErrorCode.A2A_ERROR,
          );
        };
    }
  }

  private getCurrentNetworkName(): ChainName {
    return (typeof this.config.network === 'string' ? this.config.network : 'avalanche') as ChainName;
  }

  private getDefiAgentForNetwork(network: ChainName): Evalanche {
    return network === this.getCurrentNetworkName()
      ? this.agent
      : this.agent.switchNetwork(network);
  }

  private async authorizeMcpTransaction(input: {
    to: string;
    valueWei?: string;
    data?: string;
    gasLimit?: bigint;
  }): Promise<void> {
    await this.agent.authorizeTransaction(input);
  }

  private recordMcpSpend(to: string, valueWei: string | undefined, txHash: string): void {
    this.agent.recordExternalSpend(to, valueWei ?? '0', txHash);
  }

  private isAuthorizedHTTP(req: IncomingMessage, authToken: string): boolean {
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const headerToken = typeof req.headers['x-evalanche-mcp-token'] === 'string'
      ? req.headers['x-evalanche-mcp-token']
      : '';
    return this.constantTimeTokenEquals(bearer, authToken)
      || this.constantTimeTokenEquals(headerToken, authToken);
  }

  private constantTimeTokenEquals(candidate: string, expected: string): boolean {
    if (!candidate || candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  }

  private resolveVaultTarget(target: string, explicitNetwork?: string) {
    return resolveDappTarget(
      {
        target,
        explicitNetwork,
        currentNetwork: this.getCurrentNetworkName(),
      },
      this.dappRegistry,
    );
  }

  private resolveSavaxTarget(explicitNetwork?: string) {
    return resolveDappTarget(
      {
        target: 'savax',
        explicitNetwork,
        currentNetwork: this.getCurrentNetworkName(),
      },
      this.dappRegistry,
    );
  }

  private getPolymarket(): PolymarketClient {
    if (!this.polymarket) {
      this.polymarket = new PolymarketClient(this.agent.wallet, 137);
    }
    return this.polymarket;

  }

  private estimateSellFill(orderBook: { bids: Array<{ price: number; size: number }> }, size: number): {
    averagePrice: number;
    filledSize: number;
    hasFullLiquidity: boolean;
  } {
    let remaining = size;
    let totalProceeds = 0;

    for (const bid of this.sortPolymarketOrders(orderBook.bids, 'bid')) {
      if (remaining <= 0) break;
      const fillSize = Math.min(remaining, bid.size);
      totalProceeds += fillSize * bid.price;
      remaining -= fillSize;
    }

    const filledSize = size - remaining;
    if (filledSize <= 0) {
      return { averagePrice: 0, filledSize: 0, hasFullLiquidity: false };
    }

    return {
      averagePrice: totalProceeds / filledSize,
      filledSize,
      hasFullLiquidity: remaining <= 0,
    };
  }

  private roundUpToTick(value: number, tickSize: number): number {
    const precision = Math.max(0, (tickSize.toString().split('.')[1] ?? '').length);
    const steps = Math.ceil((value + Number.EPSILON) / tickSize);
    return Number((steps * tickSize).toFixed(precision));
  }

  private normalizeUsdcDisplayAmount(raw: unknown): number {
    const parsed = Number(raw ?? 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    // Polymarket venue responses are inconsistent here: tiny balances may come back
    // as whole-USDC strings (e.g. "5"), while other paths still surface microUSDC.
    return parsed >= 1000 ? parsed / 1_000_000 : parsed;
  }

  private normalizePolymarketOutcome(value: unknown, toolName: string): 'YES' | 'NO' {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${toolName} requires 'outcome' (YES or NO).`);
    }
    const normalized = value.trim().toUpperCase();
    if (normalized !== 'YES' && normalized !== 'NO') {
      throw new Error(`${toolName} requires outcome to be YES or NO.`);
    }
    return normalized;
  }

  private requirePolymarketString(args: Record<string, unknown>, key: string, toolName: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${toolName} requires '${key}' to be a non-empty string.`);
    }
    return value.trim();
  }

  private parsePolymarketPositiveNumber(
    value: unknown,
    key: string,
    toolName: string,
    options?: { zeroToOneExclusive?: boolean },
  ): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${toolName} requires '${key}' to be a positive number.`);
    }
    if (options?.zeroToOneExclusive && (parsed <= 0 || parsed >= 1)) {
      throw new Error(`${toolName} requires '${key}' to be between 0 and 1 (exclusive).`);
    }
    return parsed;
  }

  private parsePolymarketStatus(err: unknown): number | undefined {
    if (typeof err === 'object' && err !== null) {
      const anyErr = err as Record<string, any>;
      const responseStatus = anyErr.response?.status ?? anyErr.status;
      if (typeof responseStatus === 'number') return responseStatus;
    }

    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(/\bstatus\s+(\d{3})\b/i) ?? message.match(/\breturned\s+(\d{3})\b/i);
    if (match) return Number(match[1]);
    return undefined;
  }

  private describePolymarketError(
    err: unknown,
    notFoundCode: 'market_not_found' | 'orderbook_unavailable',
  ): { code: string; status?: number; message: string } {
    const status = this.parsePolymarketStatus(err);
    const message = err instanceof Error ? err.message : String(err);
    if (status === 403) return { code: 'forbidden', status, message };
    if (status === 404) return { code: notFoundCode, status, message };
    return { code: 'upstream_error', status, message };
  }

  private normalizePolymarketMarketRecord(record: Record<string, unknown>, fallbackConditionId?: string): {
    conditionId: string;
    question: string;
    description?: string;
    startDate?: string;
    endDate?: string;
    tokens: Array<{ tokenId: string; conditionId: string; outcome: string; price?: number; volume?: number }>;
  } {
    const conditionId = String(record.condition_id ?? record.conditionId ?? fallbackConditionId ?? '');
    const tokensRaw = Array.isArray(record.tokens) ? record.tokens : [];
    const tokens = tokensRaw.map((token) => {
      const item = (token ?? {}) as Record<string, unknown>;
      const price = item.price;
      const volume = item.volume;
      return {
        tokenId: String(item.token_id ?? item.tokenId ?? ''),
        conditionId,
        outcome: String(item.outcome ?? ''),
        price: typeof price === 'number' ? price : Number.isFinite(Number(price)) ? Number(price) : undefined,
        volume: typeof volume === 'number' ? volume : Number.isFinite(Number(volume)) ? Number(volume) : undefined,
      };
    });

    return {
      conditionId,
      question: String(record.question ?? ''),
      description: typeof record.description === 'string' ? record.description : undefined,
      startDate:
        typeof record.start_date_iso === 'string'
          ? record.start_date_iso
          : typeof record.startDate === 'string'
            ? record.startDate
            : undefined,
      endDate:
        typeof record.end_date_iso === 'string'
          ? record.end_date_iso
          : typeof record.endDate === 'string'
            ? record.endDate
            : undefined,
      tokens,
    };
  }

  private sortPolymarketOrders<T extends { price: number }>(orders: T[], side: 'bid' | 'ask'): T[] {
    return [...orders].sort((a, b) => {
      const aValid = Number.isFinite(a.price) && a.price > 0;
      const bValid = Number.isFinite(b.price) && b.price > 0;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return side === 'bid' ? b.price - a.price : a.price - b.price;
    });
  }

  private normalizePolymarketOrderBook<T extends { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }>(orderBook: T): T {
    return {
      ...orderBook,
      bids: this.sortPolymarketOrders(orderBook.bids, 'bid'),
      asks: this.sortPolymarketOrders(orderBook.asks, 'ask'),
    };
  }

  private summarizePolymarketOrderBook(orderBook: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }) {
    const normalized = this.normalizePolymarketOrderBook(orderBook);
    const bidDepth = normalized.bids.reduce((total, bid) => total + bid.size, 0);
    const askDepth = normalized.asks.reduce((total, ask) => total + ask.size, 0);
    const bestBid = normalized.bids[0]?.price ?? 0;
    const bestAsk = normalized.asks[0]?.price ?? 0;
    return {
      bestBid,
      bestAsk,
      bidDepth,
      askDepth,
      spread: bestBid > 0 && bestAsk > 0 ? Number((bestAsk - bestBid).toFixed(6)) : null,
    };
  }

  /**
   * Approve the Polymarket CLOB exchange contract to spend USDC from the agent's wallet.
   * This is an ON-CHAIN transaction that must be mined before the CLOB can pull USDC
   * at order settlement time. The previous pm_approve only called the L2 API
   * (updateBalanceAllowance), which does NOT set the ERC20 allowance.
   *
   * Addresses match Polymarket's Polygon CLOB deployment:
   *   Polygon USDC:  0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
   *   Polygon CLOB:  0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
   */
  private async approveUsdcToCLOB(amountUSDC?: number): Promise<string> {
    const { createWalletClient, http, parseUnits, formatUnits } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    const CLOB_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
    const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const USDC_DECIMALS = 6;

    let pk = this.agent.wallet.privateKey;
    if (!pk) throw new Error('Agent wallet has no privateKey');
    if (!pk.startsWith('0x')) pk = `0x${pk}`;

    const account = privateKeyToAccount(pk as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    // Default: approve maxUint256 so the user doesn't need to re-approve on every order
    const approveAmount = amountUSDC !== undefined
      ? parseUnits(String(amountUSDC), USDC_DECIMALS)
      : BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    const hash = await walletClient.writeContract({
      address: USDC_CONTRACT,
      abi: [
        {
          name: 'approve',
          type: 'function',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'approve',
      args: [CLOB_CONTRACT, approveAmount],
    });

    // Wait for 1 confirmation
    const publicClient = (await import('viem')).createPublicClient({
      chain: polygon,
      transport: http(),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  private async fetchPolymarketPositions(walletAddress: string): Promise<any[]> {
    const posUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
    const posResp = await safeFetch(posUrl, { timeoutMs: 12_000, maxBytes: 2_000_000 });
    if (!posResp.ok) throw new Error(`Polymarket data-api returned ${posResp.status}`);
    const positions = await posResp.json();
    return Array.isArray(positions) ? positions : [];
  }

  private findRelevantPolymarketPosition(positions: any[], tokenId?: string) {
    if (!tokenId) return null;
    return positions.find((position) => {
      const record = (position ?? {}) as Record<string, unknown>;
      return String(record.asset ?? record.tokenId ?? record.token_id ?? '') === tokenId;
    }) ?? null;
  }

  private async inspectPolymarketMarket(conditionId: string): Promise<any> {
    try {
      const market = await this.getPolymarket().getMarket(conditionId);
      if (market) {
        return {
          ok: true,
          source: 'clob_public',
          confidence: 'direct',
          market,
        };
      }
      return {
        ok: false,
        source: 'clob_public',
        confidence: 'direct',
        error: {
          code: 'market_not_found',
          status: 404,
          message: `Polymarket market not found for conditionId=${conditionId}`,
        },
      };
    } catch (publicErr) {
      const publicError = this.describePolymarketError(publicErr, 'market_not_found');
      try {
        const authed = await this.getAuthedClobClient();
        const rawMarket = await authed.getMarket(conditionId);
        if (!rawMarket) {
          return {
            ok: false,
            source: 'clob_public+auth',
            confidence: 'direct',
            error: publicError,
          };
        }
        return {
          ok: true,
          source: 'clob_auth',
          confidence: 'direct',
          market: this.normalizePolymarketMarketRecord(rawMarket, conditionId),
          warnings: [publicError],
        };
      } catch (authErr) {
        return {
          ok: false,
          source: 'clob_public+auth',
          confidence: 'weak',
          error: publicError,
          warnings: [this.describePolymarketError(authErr, 'market_not_found')],
        };
      }
    }
  }

  private async inspectPolymarketOrderBook(tokenId: string): Promise<any> {
    try {
      const rawOrderBook = await this.getPolymarket().getOrderBook(tokenId);
      const orderBook = this.normalizePolymarketOrderBook(rawOrderBook);
      return {
        ok: true,
        source: 'clob_public',
        confidence: 'direct',
        orderBook,
        summary: this.summarizePolymarketOrderBook(orderBook),
      };
    } catch (publicErr) {
      const publicError = this.describePolymarketError(publicErr, 'orderbook_unavailable');
      try {
        const authed = await this.getAuthedClobClient();
        const rawBook = await authed.getOrderBook(tokenId);
        const orderBook = this.normalizePolymarketOrderBook({
          bids: Array.isArray(rawBook?.bids)
            ? rawBook.bids.map((bid: Record<string, unknown>) => ({
              price: Number(bid.price ?? 0),
              size: Number(bid.size ?? 0),
              orderID: String(bid.order_id ?? bid.orderID ?? ''),
            }))
            : [],
          asks: Array.isArray(rawBook?.asks)
            ? rawBook.asks.map((ask: Record<string, unknown>) => ({
              price: Number(ask.price ?? 0),
              size: Number(ask.size ?? 0),
              orderID: String(ask.order_id ?? ask.orderID ?? ''),
            }))
            : [],
        });
        return {
          ok: true,
          source: 'clob_auth',
          confidence: 'direct',
          orderBook,
          summary: this.summarizePolymarketOrderBook(orderBook),
          warnings: [publicError],
        };
      } catch (authErr) {
        return {
          ok: false,
          source: 'clob_public+auth',
          confidence: 'weak',
          error: publicError,
          warnings: [this.describePolymarketError(authErr, 'orderbook_unavailable')],
        };
      }
    }
  }

  private async resolvePolymarketMarketToken(conditionId: string, outcome: 'YES' | 'NO'): Promise<any> {
    const marketInspection = await this.inspectPolymarketMarket(conditionId);
    if (!marketInspection.ok) {
      return {
        ok: false,
        marketInspection,
        error: marketInspection.error,
      };
    }
    const token = marketInspection.market.tokens.find(
      (entry: { outcome: string }) => String(entry.outcome).toUpperCase() === outcome,
    );
    if (!token) {
      return {
        ok: false,
        marketInspection,
        error: {
          code: 'outcome_not_found',
          message: `Outcome ${outcome} not found in market ${conditionId}.`,
        },
      };
    }
    return {
      ok: true,
      marketInspection,
      token,
      tokenId: token.tokenId,
    };
  }

  /**
   * Reads the ERC20 allowance granted to the Polymarket CLOB exchange contract
   * for USDC. This is the ON-CHAIN allowance (vs the CLOB API's off-chain record
   * which can be stale). Use this when the CLOB API's getBalanceAllowance
   * returns 0 despite a recent approveUsdcToCLOB() call.
   *
   * Polygon addresses match Polymarket's CLOB collateral deployment:
   *   USDC:  0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
   *   CLOB:  0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E
   */
  private async getOnChainUsdcAllowance(): Promise<bigint> {
    const { createPublicClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { getAddress } = await import('viem/utils');

    const user = getAddress(this.agent.address);

    try {
      const client = createPublicClient({ chain: polygon, transport: http() });
      return await client.readContract({
        address: POLYMARKET_USDC_E,
        functionName: 'allowance',
        args: [user, POLYMARKET_CLOB_CONTRACT],
        abi: [{
          type: 'function',
          name: 'allowance',
          stateMutability: 'view',
          inputs: [{ type: 'address' }, { type: 'address' }],
          outputs: [{ type: 'uint256' }],
        }],
      });
    } catch {
      return 0n;
    }
  }

  private async getOnChainPusdAllowances(): Promise<Record<string, bigint>> {
    const { createPublicClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { getAddress } = await import('viem/utils');

    const user = getAddress(this.agent.address);
    const zeroed = Object.fromEntries(POLYMARKET_COLLATERAL_SPENDERS.map((spender) => [spender, 0n])) as Record<string, bigint>;

    try {
      const client = createPublicClient({ chain: polygon, transport: http() });
      const reads = await Promise.all(
        POLYMARKET_COLLATERAL_SPENDERS.map(async (spender) => {
          try {
            const allowance = await client.readContract({
              address: POLYMARKET_PUSD,
              functionName: 'allowance',
              args: [user, spender],
              abi: [{
                type: 'function',
                name: 'allowance',
                stateMutability: 'view',
                inputs: [{ type: 'address' }, { type: 'address' }],
                outputs: [{ type: 'uint256' }],
              }],
            });
            return [spender, allowance as bigint] as const;
          } catch {
            return [spender, 0n] as const;
          }
        }),
      );
      return Object.fromEntries(reads) as Record<string, bigint>;
    } catch {
      return zeroed;
    }
  }

  private extractPolymarketAllowanceMap(collateral: any): Record<string, bigint> {
    const raw = collateral?.allowances;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([spender, amount]) => {
        try {
          return [spender, BigInt(String(amount ?? '0'))];
        } catch {
          return [spender, 0n];
        }
      }),
    );
  }

  private async approvePusdCollateralSpenders(amountUSDC?: number): Promise<string[]> {
    const { createWalletClient, createPublicClient, http, parseUnits } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    let pk = this.agent.wallet.privateKey;
    if (!pk) throw new Error('Agent wallet has no privateKey');
    if (!pk.startsWith('0x')) pk = `0x${pk}`;

    const account = privateKeyToAccount(pk as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });
    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(),
    });

    const approveAmount = amountUSDC !== undefined
      ? parseUnits(String(amountUSDC), 6)
      : BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    const txHashes: string[] = [];
    for (const spender of POLYMARKET_COLLATERAL_SPENDERS) {
      const currentAllowance = await publicClient.readContract({
        address: POLYMARKET_PUSD,
        abi: [{
          name: 'allowance',
          type: 'function',
          inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        } as any],
        functionName: 'allowance',
        args: [account.address, spender as `0x${string}`],
      }) as bigint;

      if (currentAllowance >= approveAmount) continue;

      const hash = await walletClient.writeContract({
        address: POLYMARKET_PUSD,
        abi: [{
          name: 'approve',
          type: 'function',
          inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'nonpayable',
        } as any],
        functionName: 'approve',
        args: [spender as `0x${string}`, approveAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      txHashes.push(hash);
    }

    return txHashes;
  }

  private async getPolymarketVenueBalances(tokenId?: string): Promise<any> {
    try {
      const authed = await this.getAuthedClobClient();
      const collateral = typeof authed.getBalanceAllowance === 'function'
        ? await authed.getBalanceAllowance({ asset_type: 'COLLATERAL' })
        : null;
      const conditional = tokenId && typeof authed.getBalanceAllowance === 'function'
        ? await authed.getBalanceAllowance({ asset_type: 'CONDITIONAL', token_id: tokenId })
        : null;
      const venueBalances = typeof authed.getBalances === 'function'
        ? await authed.getBalances()
        : {
          walletAddress: this.agent.address,
          collateral: collateral ?? null,
          conditional: conditional ?? null,
        };

      const clobAllowanceMap = this.extractPolymarketAllowanceMap(collateral);
      const onChainUsdcAllowanceRaw = await this.getOnChainUsdcAllowance();
      const onChainPusdAllowancesRaw = await this.getOnChainPusdAllowances();
      const mergedAllowanceMap = Object.fromEntries(
        POLYMARKET_COLLATERAL_SPENDERS.map((spender) => {
          const clobValue = clobAllowanceMap[spender] ?? 0n;
          const onChainValue = onChainPusdAllowancesRaw[spender] ?? 0n;
          return [spender, onChainValue > clobValue ? onChainValue : clobValue];
        }),
      ) as Record<string, bigint>;
      const maxMergedAllowanceRaw = Object.values(mergedAllowanceMap).reduce((max, value) => value > max ? value : max, 0n);
      const effectiveAllowanceRaw = maxMergedAllowanceRaw > 0n ? maxMergedAllowanceRaw : onChainUsdcAllowanceRaw;
      const clobAllowanceSource = maxMergedAllowanceRaw > 0n ? 'pusd_spender' : (onChainUsdcAllowanceRaw > 0n ? 'on_chain' : 'clob');

      return {
        ok: true,
        walletAddress: this.agent.address,
        collateral: collateral
          ? {
            balance: this.normalizeUsdcDisplayAmount(collateral.balance),
            rawBalance: String(collateral.balance ?? '0'),
            allowance: this.normalizeUsdcDisplayAmount(effectiveAllowanceRaw.toString()),
            rawAllowance: effectiveAllowanceRaw.toString(),
            allowanceSource: clobAllowanceSource,
            allowances: Object.fromEntries(
              Object.entries(mergedAllowanceMap).map(([spender, value]) => [spender, this.normalizeUsdcDisplayAmount(value.toString())]),
            ),
            rawAllowances: Object.fromEntries(
              Object.entries(mergedAllowanceMap).map(([spender, value]) => [spender, value.toString()]),
            ),
            rawUsdcClobAllowance: onChainUsdcAllowanceRaw.toString(),
          }
          : {
            balance: 0,
            allowance: this.normalizeUsdcDisplayAmount(effectiveAllowanceRaw.toString()),
            rawAllowance: effectiveAllowanceRaw.toString(),
            allowanceSource: clobAllowanceSource,
            allowances: Object.fromEntries(
              Object.entries(mergedAllowanceMap).map(([spender, value]) => [spender, this.normalizeUsdcDisplayAmount(value.toString())]),
            ),
            rawAllowances: Object.fromEntries(
              Object.entries(mergedAllowanceMap).map(([spender, value]) => [spender, value.toString()]),
            ),
            rawUsdcClobAllowance: onChainUsdcAllowanceRaw.toString(),
          },
        conditional: conditional
          ? {
            tokenId,
            balance: Number(conditional.balance ?? 0),
            allowance: Number(conditional.allowance ?? 0),
          }
          : null,
        venueBalances,
      };
    } catch (err) {
      return {
        ok: false,
        walletAddress: this.agent.address,
        error: this.describePolymarketError(err, 'orderbook_unavailable'),
      };
    }
  }

  private buildPolymarketPreflightVerdict(checks: Array<{ status: 'pass' | 'risky' | 'blocked' }>): 'ready' | 'risky' | 'blocked' {
    if (checks.some((check) => check.status === 'blocked')) return 'blocked';
    if (checks.some((check) => check.status === 'risky')) return 'risky';
    return 'ready';
  }

  private getPolymarketOrderId(orderResult: any): string | null {
    const orderId = orderResult?.orderID ?? orderResult?.orderIds?.[0];
    if (typeof orderId !== 'string' || orderId.trim().length === 0 || orderId === 'unknown') return null;
    return orderId;
  }

  private getPolymarketSubmissionFailure(orderResult: any): { code: string; status: number | string | null; message: string } | null {
    if (!orderResult || typeof orderResult !== 'object') return null;

    const status = typeof orderResult.status === 'number' || typeof orderResult.status === 'string'
      ? orderResult.status
      : null;
    const errorValue = orderResult.error;
    const message =
      (typeof errorValue === 'string' && errorValue) ||
      (typeof errorValue?.message === 'string' && errorValue.message) ||
      (typeof orderResult.message === 'string' && orderResult.message) ||
      (typeof orderResult.reason === 'string' && orderResult.reason) ||
      (typeof orderResult.msg === 'string' && orderResult.msg) ||
      null;

    const hasFailureStatus = typeof status === 'number' && status >= 400;
    const hasExplicitFailure = orderResult.success === false || errorValue === true || message !== null;
    if (!hasFailureStatus && !hasExplicitFailure) return null;

    const lowerMessage = message?.toLowerCase() ?? '';
    const code = /geoblock|restricted in your region/.test(lowerMessage)
      ? 'geoblocked'
      : 'submission_rejected';

    return {
      code,
      status,
      message: message ?? 'Polymarket venue rejected the submission.',
    };
  }

  private buildSkippedPolymarketVerification(reason: { code: string; status: number | string | null; message: string }, tokenId?: string | null): any {
    return {
      sourceOfTruth: 'venue',
      skipped: true,
      reason: reason.code,
      tokenId: tokenId ?? null,
      error: {
        status: reason.status,
        message: reason.message,
      },
    };
  }

  private async runPolymarketPreflight(input: {
    action: 'buy' | 'sell' | 'limit_sell';
    conditionId: string;
    outcome: 'YES' | 'NO';
    amountUSDC?: number;
    orderType?: 'market' | 'limit';
    limitPrice?: number;
    price?: number;
    shares?: number;
    maxSlippagePct?: number;
    postOnly?: boolean;
  }): Promise<any> {
    const tokenResolution = await this.resolvePolymarketMarketToken(input.conditionId, input.outcome);
    const checks: Array<{ name: string; status: 'pass' | 'risky' | 'blocked'; message: string; details?: unknown }> = [];
    const warnings: string[] = [];

    if (!tokenResolution.ok) {
      checks.push({
        name: 'market',
        status: 'blocked',
        message: tokenResolution.error.message,
        details: tokenResolution.error,
      });
      return {
        action: input.action,
        request: input,
        verdict: 'blocked',
        checks,
        warnings,
        market: tokenResolution.marketInspection ?? null,
        token: null,
      };
    }

    const tokenId = tokenResolution.tokenId as string;
    const marketInspection = tokenResolution.marketInspection;
    const orderBookInspection = await this.inspectPolymarketOrderBook(tokenId);
    const balances = await this.getPolymarketVenueBalances(tokenId);
    const positions = await this.fetchPolymarketPositions(this.agent.address).catch(() => []);
    const relevantPosition = this.findRelevantPolymarketPosition(positions, tokenId);

    checks.push({
      name: 'market',
      status: 'pass',
      message: `Resolved ${input.outcome} token ${tokenId} for market ${input.conditionId}.`,
    });

    if (!orderBookInspection.ok) {
      checks.push({
        name: 'orderbook',
        status: 'blocked',
        message: orderBookInspection.error.message,
        details: orderBookInspection.error,
      });
    } else {
      checks.push({
        name: 'orderbook',
        status: 'pass',
        message: `Order book available with best bid ${orderBookInspection.summary.bestBid} and best ask ${orderBookInspection.summary.bestAsk}.`,
        details: orderBookInspection.summary,
      });
    }

    if (!balances.ok) {
      checks.push({
        name: 'auth',
        status: 'blocked',
        message: balances.error.message,
        details: balances.error,
      });
    }

    const summary = orderBookInspection.ok ? orderBookInspection.summary : null;
    const collateralBalance = balances.ok ? Number(balances.collateral?.balance ?? 0) : 0;
    const collateralAllowance = balances.ok ? Number(balances.collateral?.allowance ?? 0) : 0;
    const conditionalBalance = balances.ok ? Number(balances.conditional?.balance ?? 0) : 0;

    const estimates: Record<string, unknown> = {};

    if (input.action === 'buy') {
      const amountUSDC = input.amountUSDC ?? 0;
      const orderType = input.orderType ?? 'market';
      checks.push({
        name: 'collateral_balance',
        status: collateralBalance >= amountUSDC ? 'pass' : 'blocked',
        message:
          collateralBalance >= amountUSDC
            ? `Collateral balance ${collateralBalance} covers requested ${amountUSDC} USDC.`
            : `Collateral balance ${collateralBalance} is below requested ${amountUSDC} USDC.`,
      });
      checks.push({
        name: 'collateral_allowance',
        status: collateralAllowance >= amountUSDC ? 'pass' : 'blocked',
        message:
          collateralAllowance >= amountUSDC
            ? `Collateral allowance ${collateralAllowance} covers requested ${amountUSDC} USDC.`
            : `Collateral allowance ${collateralAllowance} is below requested ${amountUSDC} USDC. Run pm_approve first.`,
      });

      if (orderType === 'limit') {
        const limitPrice = input.limitPrice ?? 0;
        const size = limitPrice > 0 ? amountUSDC / limitPrice : 0;
        estimates.limitOrderShares = size;
        checks.push({
          name: 'limit_price',
          status: limitPrice > 0 && limitPrice < 1 ? 'pass' : 'blocked',
          message:
            limitPrice > 0 && limitPrice < 1
              ? `Limit price ${limitPrice} is valid.`
              : `Limit price ${limitPrice} must be between 0 and 1.`,
        });
      } else if (summary) {
        const bestAsk = Number(summary.bestAsk ?? 0);
        checks.push({
          name: 'best_ask',
          status: bestAsk > 0 ? 'pass' : 'blocked',
          message:
            bestAsk > 0
              ? `Best ask ${bestAsk} is available for market buy routing.`
              : 'No ask liquidity is visible for a market buy.',
        });
        if (bestAsk > 0) estimates.estimatedShares = amountUSDC / bestAsk;
      }
    }

    if (input.action === 'sell') {
      const amountUSDC = input.amountUSDC ?? 0;
      const bestBid = Number(summary?.bestBid ?? 0);
      checks.push({
        name: 'best_bid',
        status: bestBid > 0 ? 'pass' : 'blocked',
        message:
          bestBid > 0
            ? `Best bid ${bestBid} is available for immediate sell routing.`
            : 'No bid liquidity is visible for this outcome.',
      });

      if (bestBid > 0 && orderBookInspection.ok) {
        const desiredShares = amountUSDC / bestBid;
        const fillEstimate = this.estimateSellFill(orderBookInspection.orderBook, desiredShares);
        const maxSlippagePct = input.maxSlippagePct ?? 1;
        const minAcceptablePrice = bestBid * (1 - maxSlippagePct / 100);
        estimates.desiredShares = desiredShares;
        estimates.fillEstimate = fillEstimate;
        estimates.minAcceptablePrice = minAcceptablePrice;

        checks.push({
          name: 'conditional_balance',
          status: conditionalBalance >= desiredShares ? 'pass' : 'blocked',
          message:
            conditionalBalance >= desiredShares
              ? `Conditional balance ${conditionalBalance} covers desired sell size ${desiredShares}.`
              : `Conditional balance ${conditionalBalance} is below desired sell size ${desiredShares}.`,
        });
        checks.push({
          name: 'visible_liquidity',
          status: fillEstimate.hasFullLiquidity ? 'pass' : 'blocked',
          message:
            fillEstimate.hasFullLiquidity
              ? `Visible bids can absorb ${desiredShares} shares.`
              : `Visible bids cannot fully absorb ${desiredShares} shares.`,
          details: fillEstimate,
        });
        checks.push({
          name: 'slippage',
          status: fillEstimate.averagePrice >= minAcceptablePrice ? 'pass' : 'blocked',
          message:
            fillEstimate.averagePrice >= minAcceptablePrice
              ? `Estimated average fill ${fillEstimate.averagePrice} stays above the minimum acceptable ${minAcceptablePrice}.`
              : `Estimated average fill ${fillEstimate.averagePrice} falls below the minimum acceptable ${minAcceptablePrice}.`,
          details: { averagePrice: fillEstimate.averagePrice, minAcceptablePrice },
        });
      }
    }

    if (input.action === 'limit_sell') {
      const price = input.price ?? 0;
      const shares = input.shares ?? 0;
      const postOnly = input.postOnly ?? true;
      const bestBid = Number(summary?.bestBid ?? 0);

      checks.push({
        name: 'conditional_balance',
        status: conditionalBalance >= shares ? 'pass' : 'blocked',
        message:
          conditionalBalance >= shares
            ? `Conditional balance ${conditionalBalance} covers ${shares} shares.`
            : `Conditional balance ${conditionalBalance} is below ${shares} shares.`,
      });
      checks.push({
        name: 'price',
        status: price > 0 && price < 1 ? 'pass' : 'blocked',
        message:
          price > 0 && price < 1
            ? `Limit price ${price} is valid.`
            : `Limit price ${price} must be between 0 and 1.`,
      });
      if (postOnly && bestBid > 0 && price <= bestBid) {
        checks.push({
          name: 'post_only_cross',
          status: 'blocked',
          message: `postOnly=true would reject because limit price ${price} crosses or matches best bid ${bestBid}.`,
        });
      } else if (!postOnly && bestBid > 0 && price <= bestBid) {
        checks.push({
          name: 'crossing_limit',
          status: 'risky',
          message: `Limit sell price ${price} crosses visible bid ${bestBid} and may execute immediately.`,
        });
      }
    }

    const verdict = this.buildPolymarketPreflightVerdict(checks);
    if (marketInspection?.warnings) {
      warnings.push(...marketInspection.warnings.map((warning: { message: string }) => warning.message));
    }
    if (orderBookInspection?.warnings) {
      warnings.push(...orderBookInspection.warnings.map((warning: { message: string }) => warning.message));
    }

    return {
      action: input.action,
      request: input,
      verdict,
      checks,
      warnings,
      market: marketInspection,
      token: tokenResolution.token,
      tokenId,
      orderbook: orderBookInspection,
      balances,
      positions: {
        walletAddress: this.agent.address,
        count: positions.length,
        relevantPosition,
      },
      estimates,
    };
  }

  private async reconcilePolymarketVenue(input: {
    walletAddress?: string;
    orderId?: string;
    conditionId?: string;
    outcome?: 'YES' | 'NO';
    tokenId?: string;
  }): Promise<any> {
    const walletAddress = input.walletAddress ?? this.agent.address;
    let tokenId = input.tokenId;
    let tokenResolution: any = null;
    if (!tokenId && input.conditionId && input.outcome) {
      tokenResolution = await this.resolvePolymarketMarketToken(input.conditionId, input.outcome);
      if (tokenResolution.ok) tokenId = tokenResolution.tokenId;
    }

    const authed = await this.getAuthedClobClient();
    const positions = await this.fetchPolymarketPositions(walletAddress).catch(() => []);
    const balances = await this.getPolymarketVenueBalances(tokenId);
    const openOrders = typeof authed.getOpenOrders === 'function'
      ? await authed.getOpenOrders(tokenId)
      : [];
    const trades = typeof authed.getTrades === 'function'
      ? await authed.getTrades(tokenId)
      : [];
    const order = input.orderId && typeof authed.getOrder === 'function'
      ? await authed.getOrder(input.orderId)
      : null;

    const openOrderMatch = input.orderId
      ? (Array.isArray(openOrders)
        ? openOrders.find((entry: Record<string, unknown>) => String(entry.orderID ?? entry.id ?? '') === input.orderId)
        : null)
      : null;
    const relevantPosition = this.findRelevantPolymarketPosition(positions, tokenId);

    const orderStatus = order
      ? String((order as Record<string, unknown>).status ?? 'unknown')
      : openOrderMatch
        ? 'OPEN'
        : input.orderId
          ? 'NOT_FOUND'
          : null;

    return {
      sourceOfTruth: 'venue',
      walletAddress,
      tokenId: tokenId ?? null,
      tokenResolution,
      order: order
        ? {
          orderId: String((order as Record<string, unknown>).orderID ?? (order as Record<string, unknown>).id ?? input.orderId ?? ''),
          status: orderStatus,
          averageFillPrice: Number((order as Record<string, unknown>).average_fill_price ?? (order as Record<string, unknown>).averageFillPrice ?? 0),
          size: Number((order as Record<string, unknown>).size ?? 0),
          raw: order,
        }
        : null,
      openOrders: Array.isArray(openOrders) ? openOrders : [],
      trades: Array.isArray(trades) ? trades : [],
      balances,
      positions: {
        walletAddress,
        count: positions.length,
        relevantPosition,
        all: positions,
      },
      reconciliation: {
        orderId: input.orderId ?? null,
        orderState: orderStatus,
        isOpen: Boolean(openOrderMatch),
        recentTradeCount: Array.isArray(trades) ? trades.length : 0,
        positionSize: relevantPosition
          ? Number((relevantPosition as Record<string, unknown>).size ?? (relevantPosition as Record<string, unknown>).balance ?? 0)
          : 0,
      },
    };
  }

  private unwrapPolymarketCliList(payload: unknown, key?: string): any[] {
    if (Array.isArray(payload)) return payload;
    const record = (payload ?? {}) as Record<string, unknown>;
    if (key && Array.isArray(record[key])) return record[key] as any[];
    if (Array.isArray(record.data)) return record.data as any[];
    if (Array.isArray(record.orders)) return record.orders as any[];
    if (Array.isArray(record.trades)) return record.trades as any[];
    if (Array.isArray(record.positions)) return record.positions as any[];
    return [];
  }

  private normalizeCliSide(side: unknown): 'buy' | 'sell' {
    const value = String(side ?? '').toLowerCase();
    if (value === 'buy' || value === 'sell') return value;
    if (value.includes('buy')) return 'buy';
    if (value.includes('sell')) return 'sell';
    throw new Error(`Unsupported Polymarket side: ${String(side)}`);
  }

  private buildPolymarketCliClient(): any {
    const cli = this.polymarketCli;
    return {
      __evalancheClientVersion: 'official-cli',
      getMarket: (conditionId: string) => cli.clobMarket(conditionId),
      getOrderBook: (tokenId: string) => cli.orderBook(tokenId),
      getOpenOrders: async (tokenId?: string) => this.unwrapPolymarketCliList(await cli.openOrders(tokenId), 'orders'),
      getTrades: async (tokenId?: string) => this.unwrapPolymarketCliList(await cli.trades(tokenId), 'trades'),
      getOrder: (orderId: string) => cli.order(orderId),
      cancelOrder: (orderId: string) => cli.cancelOrder(orderId),
      getBalances: async () => ({ collateral: await cli.balance('collateral') }),
      getBalanceAllowance: async (request: Record<string, unknown>) => {
        const assetType = String(request.asset_type ?? request.assetType ?? 'COLLATERAL').toLowerCase() === 'conditional'
          ? 'conditional'
          : 'collateral';
        const tokenId = typeof request.token_id === 'string'
          ? request.token_id
          : typeof request.tokenId === 'string'
            ? request.tokenId
            : undefined;
        return cli.balance(assetType, tokenId);
      },
      updateBalanceAllowance: async (request: Record<string, unknown>) => {
        const assetType = String(request.asset_type ?? request.assetType ?? 'COLLATERAL').toLowerCase() === 'conditional'
          ? 'conditional'
          : 'collateral';
        const tokenId = typeof request.token_id === 'string'
          ? request.token_id
          : typeof request.tokenId === 'string'
            ? request.tokenId
            : undefined;
        const args = ['clob', 'update-balance', '--asset-type', assetType];
        if (tokenId) args.push('--token', tokenId);
        return cli.runJson(args, { requiresPrivateKey: true });
      },
      createAndPostOrder: (order: Record<string, unknown>, _marketOptions?: Record<string, unknown>, orderType?: string) => cli.createOrder({
        tokenId: String(order.tokenID ?? order.tokenId ?? order.token ?? ''),
        side: this.normalizeCliSide(order.side),
        price: String(order.price),
        size: String(order.size),
        orderType: orderType ?? String(order.orderType ?? 'GTC'),
        postOnly: Boolean(order.postOnly),
      }),
      createAndPostMarketOrder: (order: Record<string, unknown>) => cli.marketOrder({
        tokenId: String(order.tokenID ?? order.tokenId ?? order.token ?? ''),
        side: this.normalizeCliSide(order.side),
        amount: String(order.amount),
        orderType: String(order.orderType ?? 'FOK'),
      }),
      createOrder: async (order: Record<string, unknown>) => order,
      postOrder: async (order: Record<string, unknown>, orderType = 'GTC', _deferExec = false, postOnly = false) => cli.createOrder({
        tokenId: String(order.tokenID ?? order.tokenId ?? order.token ?? ''),
        side: this.normalizeCliSide(order.side),
        price: String(order.price),
        size: String(order.size),
        orderType,
        postOnly,
      }),
    };
  }

  private async getPolygonWalletContext(): Promise<{ walletClient: any; account: { address: `0x${string}` } }> {
    const { createWalletClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    let pk = this.agent.wallet.privateKey;
    if (!pk) throw new Error('Agent wallet has no privateKey — cannot create authenticated Polymarket client');
    if (!pk.startsWith('0x')) pk = `0x${pk}`;

    const account = privateKeyToAccount(pk as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http('https://polygon-bor-rpc.publicnode.com'),
    });

    return { walletClient, account };
  }

  private async getAuthedClobClient(): Promise<any> {
    this.authedClobClient = this.buildPolymarketCliClient();
    return this.authedClobClient;
  }

  private async getAuthedClobClientV2(): Promise<any> {
    return this.getAuthedClobClient();
  }

  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          return this.ok(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'evalanche',
              version: '1.8.8',
            },
          });

        case 'tools/list':
          return this.ok(id, { tools: TOOLS });

        case 'tools/call':
          return this.handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> });

        case 'notifications/initialized':
          return this.ok(id, {});

        default:
          return this.error(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof EvalancheError ? -32000 : -32603;
      return this.error(id, code, message);
    }
  }

  /** Normalize token address — convert "native" shorthand to the zero address */
  private normalizeToken(token: string): string {
    return token.toLowerCase() === 'native' ? NATIVE_TOKEN : token;
  }

  /** Handle a tools/call request */
  private async handleToolCall(
    id: string | number,
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<MCPResponse> {
    const { name, arguments: args = {} } = params;

    try {
      let result: unknown;

      switch (name) {
        case 'get_address':
          result = { address: this.agent.address };
          break;

        case 'get_balance': {
          const addr = (args.address as string) || this.agent.address;
          const balance = await this.agent.provider.getBalance(addr);
          const { formatEther } = await import('ethers');
          const chainInfo = this.agent.getChainInfo();
          const symbol = 'currency' in chainInfo ? chainInfo.currency.symbol : 'ETH';
          result = { address: addr, balance: formatEther(balance), unit: symbol };
          break;
        }

        case 'get_holdings':
          result = await this.agent.holdings().scan({
            walletAddress: typeof args.walletAddress === 'string' ? args.walletAddress : undefined,
            chains: Array.isArray(args.chains) ? args.chains as any : undefined,
            include: Array.isArray(args.include) ? args.include as any : undefined,
            protocols: Array.isArray(args.protocols) ? args.protocols as string[] : undefined,
          });
          break;

        case 'search_registry':
          result = this.agent.holdings().getRegistry().search(String(args.query ?? ''), {
            chain: typeof args.chain === 'string' ? args.chain : undefined,
            category: typeof args.category === 'string' ? args.category : undefined,
          });
          break;

        case 'registry_status':
          result = this.agent.holdings().getRegistry().status();
          break;

        case 'resolve_identity':
          result = await this.agent.resolveIdentity();
          break;

        case 'resolve_agent': {
          const resolver = new IdentityResolver(this.agent.provider, {
            agentId: args.agentId as string,
            registry: args.registry as string | undefined,
          });
          result = await resolver.resolve();
          break;
        }

        case 'send_avax': {
          const txResult = await this.agent.send({
            to: args.to as string,
            value: args.value as string,
          });
          result = { hash: txResult.hash, status: txResult.receipt.status };
          break;
        }

        case 'call_contract': {
          const txResult = await this.agent.call({
            contract: args.contract as string,
            abi: args.abi as string[],
            method: args.method as string,
            args: args.args as unknown[],
            value: args.value as string | undefined,
          });
          result = { hash: txResult.hash, status: txResult.receipt.status };
          break;
        }

        case 'sign_message': {
          const signature = await this.agent.signMessage(args.message as string);
          result = { signature, address: this.agent.address };
          break;
        }

        case 'pay_and_fetch': {
          const fetchResult = await this.agent.payAndFetch(args.url as string, {
            maxPayment: args.maxPayment as string,
            method: args.method as string | undefined,
            headers: args.headers as Record<string, string> | undefined,
            body: args.body as string | undefined,
          });
          result = fetchResult;
          break;
        }

        case 'submit_feedback': {
          const hash = await this.agent.submitFeedback({
            targetAgentId: args.targetAgentId as string,
            taskRef: args.taskRef as string,
            score: args.score as number,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          result = { hash };
          break;
        }

        case 'get_network': {
          const networkName = typeof this.config.network === 'string'
            ? this.config.network
            : 'custom';
          const chainInfo = this.agent.getChainInfo();
          result = { network: networkName, ...chainInfo };
          break;
        }

        case 'get_supported_chains': {
          const includeTestnets = (args.includeTestnets as boolean) ?? true;
          const chains = getAllChains(includeTestnets);
          result = {
            count: chains.length,
            chains: chains.map(c => ({
              id: c.id,
              name: c.name,
              shortName: c.shortName,
              currency: c.currency.symbol,
              explorer: c.explorer,
              isTestnet: c.isTestnet ?? false,
            })),
          };
          break;
        }

        case 'get_chain_info': {
          if (args.chainId) {
            const { getChainById } = await import('../utils/chains');
            const chain = getChainById(args.chainId as number);
            if (!chain) {
              result = { error: `Unknown chain ID: ${args.chainId}` };
            } else {
              result = chain;
            }
          } else {
            result = this.agent.getChainInfo();
          }
          break;
        }

        case 'get_bridge_quote': {
          const quote = await this.agent.getBridgeQuote({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
          });
          result = {
            id: quote.id,
            fromChainId: quote.fromChainId,
            toChainId: quote.toChainId,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            estimatedGas: quote.estimatedGas,
            estimatedTime: quote.estimatedTime,
            tool: quote.tool,
          };
          break;
        }

        case 'get_bridge_routes': {
          const routes = await this.agent.getBridgeRoutes({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
          });
          result = {
            count: routes.length,
            routes: routes.map(r => ({
              id: r.id,
              fromAmount: r.fromAmount,
              toAmount: r.toAmount,
              estimatedGas: r.estimatedGas,
              estimatedTime: r.estimatedTime,
              tool: r.tool,
            })),
          };
          break;
        }

        case 'bridge_tokens': {
          const txResult = await this.agent.bridgeTokens({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            toAddress: args.toAddress as string | undefined,
            slippage: args.slippage as number | undefined,
          });
          result = txResult;
          break;
        }

        case 'fund_destination_gas': {
          const txResult = await this.agent.fundDestinationGas({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            toAddress: (args.toAddress as string) || this.agent.address,
            destinationGasAmount: args.destinationGasAmount as string | undefined,
          });
          result = txResult;
          break;
        }

        case 'switch_network': {
          const networkName = args.network as string;
          // Validate the network name
          const networkConfig = getNetworkConfig(networkName as EvalancheConfig['network'] & string);
          // Recreate agent on the new network
          const currentNetwork = this.config.network ?? 'avalanche';
          this.config = {
            ...this.config,
            network: networkName as EvalancheConfig['network'] & string,
            rpcOverride: currentNetwork === networkName ? this.config.rpcOverride : undefined,
          };
          this.agent = new Evalanche(this.config);
          this.rebindAgentState();
          result = { network: networkName, ...networkConfig, address: this.agent.address };
          break;
        }

        case 'arena_buy': {
          const { parseUnits, formatUnits } = await import('ethers');
          const swap = new ArenaSwapClient(this.agent.wallet);
          const swapResult = await swap.buyArenaToken(
            args.tokenAddress as string,
            parseUnits(args.amount as string, 18),
            parseUnits(args.maxArenaSpend as string, 18),
          );
          result = { txHash: swapResult.txHash, success: swapResult.success, tokenId: swapResult.tokenId.toString() };
          break;
        }

        case 'arena_sell': {
          const { parseUnits } = await import('ethers');
          const swap = new ArenaSwapClient(this.agent.wallet);
          const swapResult = await swap.sellArenaToken(
            args.tokenAddress as string,
            parseUnits(args.amount as string, 18),
            parseUnits(args.minArenaReceive as string, 18),
          );
          result = { txHash: swapResult.txHash, success: swapResult.success, tokenId: swapResult.tokenId.toString() };
          break;
        }

        case 'arena_token_info': {
          const swap = new ArenaSwapClient(this.agent.wallet);
          const tokenId = await swap.getArenaTokenId(args.tokenAddress as string);
          const info = await swap.getTokenInfo(tokenId);
          result = {
            tokenId: tokenId.toString(),
            tokenAddress: info.tokenAddress,
            protocolFee: info.protocolFee,
            creatorFee: info.creatorFee,
            referralFee: info.referralFee,
            tokenCreationBuyFee: info.tokenCreationBuyFee.toString(),
            curveScaler: info.curveScaler.toString(),
            a: info.a,
          };
          break;
        }

        case 'arena_buy_cost': {
          const { parseUnits, formatUnits } = await import('ethers');
          const swap = new ArenaSwapClient(this.agent.wallet);
          const cost = await swap.calculateBuyCost(
            args.tokenAddress as string,
            parseUnits(args.amount as string, 18),
          );
          result = { costArena: formatUnits(cost, 18), costWei: cost.toString() };
          break;
        }

        case 'approve_and_call': {
          const tokenAddress = args.tokenAddress as string;
          const targetAddress = (args.targetAddress as string | undefined) ?? (args.spenderAddress as string);
          const valueWei = args.valueWei ? String(args.valueWei) : undefined;
          await this.authorizeMcpTransaction({
            to: tokenAddress,
            valueWei: '0',
            data: APPROVE_SELECTOR,
          });
          await this.authorizeMcpTransaction({
            to: targetAddress,
            valueWei: valueWei ?? '0',
            data: args.contractCallData as string,
            gasLimit: args.gasLimit ? BigInt(args.gasLimit as string) : undefined,
          });
          const approveCallResult = await approveAndCall(
            this.agent.wallet,
            tokenAddress,
            args.spenderAddress as string,
            BigInt(args.amount as string),
            {
              to: targetAddress,
              data: args.contractCallData as string,
              value: valueWei ? BigInt(valueWei) : undefined,
              gasLimit: args.gasLimit ? BigInt(args.gasLimit as string) : undefined,
            },
          );
          if (approveCallResult.success) {
            this.recordMcpSpend(targetAddress, valueWei, approveCallResult.callTxHash);
          }
          result = approveCallResult;
          break;
        }

        case 'upgrade_proxy': {
          await this.authorizeMcpTransaction({
            to: args.proxyAddress as string,
            valueWei: '0',
            data: UUPS_UPGRADE_TO_AND_CALL_SELECTOR,
          });
          const upgradeResult = await upgradeProxy(
            this.agent.wallet,
            args.proxyAddress as string,
            args.newImplementationAddress as string,
            args.initData as string | undefined,
          );
          if (upgradeResult.success) {
            this.recordMcpSpend(args.proxyAddress as string, '0', upgradeResult.txHash);
          }
          result = upgradeResult;
          break;
        }

        case 'dydx_get_markets': {
          const dydx = await this.agent.dydx();
          const markets = await dydx.getMarkets();
          result = { count: markets.length, markets };
          break;
        }

        case 'dydx_has_market': {
          const dydx = await this.agent.dydx();
          const exists = await dydx.hasMarket(args.ticker as string);
          result = { ticker: args.ticker, exists };
          break;
        }

        case 'dydx_get_balance': {
          const dydx = await this.agent.dydx();
          const balance = await dydx.getBalance();
          result = { balance, unit: 'USDC' };
          break;
        }

        case 'dydx_get_positions': {
          const dydx = await this.agent.dydx();
          const positions = await dydx.getPositions();
          result = { count: positions.length, positions };
          break;
        }

        case 'dydx_place_market_order': {
          const dydx = await this.agent.dydx();
          const orderId = await dydx.placeMarketOrder({
            market: args.market as string,
            side: args.side as 'BUY' | 'SELL',
            size: args.size as string,
            reduceOnly: args.reduceOnly as boolean | undefined,
          });
          result = { orderId };
          break;
        }

        case 'dydx_place_limit_order': {
          const dydx = await this.agent.dydx();
          const orderId = await dydx.placeLimitOrder({
            market: args.market as string,
            side: args.side as 'BUY' | 'SELL',
            size: args.size as string,
            price: args.price as string,
            timeInForce: args.timeInForce as 'GTT' | 'FOK' | 'IOC' | undefined,
            goodTilSeconds: args.goodTilSeconds as number | undefined,
            reduceOnly: args.reduceOnly as boolean | undefined,
            postOnly: args.postOnly as boolean | undefined,
          });
          result = { orderId };
          break;
        }

        case 'dydx_cancel_order': {
          const dydx = await this.agent.dydx();
          await dydx.cancelOrder(args.orderId as string);
          result = { success: true };
          break;
        }

        case 'dydx_close_position': {
          const dydx = await this.agent.dydx();
          const orderId = await dydx.closePosition(args.market as string);
          result = { orderId };
          break;
        }

        case 'dydx_get_orders': {
          const dydx = await this.agent.dydx();
          const orders = await dydx.getOrders(args.status as string | undefined);
          result = { count: orders.length, orders };
          break;
        }

        case 'hyperliquid_get_markets': {
          const hyperliquid = await this.agent.hyperliquid();
          const markets = await hyperliquid.getMarkets();
          result = { count: markets.length, markets };
          break;
        }

        case 'hyperliquid_get_account_state': {
          const hyperliquid = await this.agent.hyperliquid();
          result = await hyperliquid.getAccountState();
          break;
        }

        case 'hyperliquid_get_positions': {
          const hyperliquid = await this.agent.hyperliquid();
          const positions = await hyperliquid.getPositions();
          result = { count: positions.length, positions };
          break;
        }

        case 'hyperliquid_place_market_order': {
          const hyperliquid = await this.agent.hyperliquid();
          const request = {
            market: args.market as string,
            side: args.side as 'BUY' | 'SELL',
            size: args.size as string,
            reduceOnly: args.reduceOnly as boolean | undefined,
          };
          const submission = await hyperliquid.placeMarketOrderDetailed(request);
          const verification = submission.orderId
            ? await hyperliquid.getOrder(submission.orderId)
            : { status: submission.status, raw: submission.raw };
          result = {
            tool: 'hyperliquid_place_market_order',
            request,
            submission,
            verification,
            warnings: [],
          };
          break;
        }

        case 'hyperliquid_place_limit_order': {
          const hyperliquid = await this.agent.hyperliquid();
          const request = {
            market: args.market as string,
            side: args.side as 'BUY' | 'SELL',
            size: args.size as string,
            price: args.price as string,
            timeInForce: args.timeInForce as 'GTT' | 'FOK' | 'IOC' | undefined,
            reduceOnly: args.reduceOnly as boolean | undefined,
            postOnly: args.postOnly as boolean | undefined,
          };
          const submission = await hyperliquid.placeLimitOrderDetailed(request);
          const verification = submission.orderId
            ? await hyperliquid.getOrder(submission.orderId)
            : { status: submission.status, raw: submission.raw };
          result = {
            tool: 'hyperliquid_place_limit_order',
            request,
            submission,
            verification,
            warnings: [],
          };
          break;
        }

        case 'hyperliquid_cancel_order': {
          const hyperliquid = await this.agent.hyperliquid();
          const request = { orderId: args.orderId as string };
          await hyperliquid.cancelOrder(request.orderId);
          const verification = await hyperliquid.getOrder(request.orderId);
          result = {
            tool: 'hyperliquid_cancel_order',
            request,
            submission: { status: 'canceled', orderId: request.orderId },
            verification,
            warnings: [],
          };
          break;
        }

        case 'hyperliquid_close_position': {
          const hyperliquid = await this.agent.hyperliquid();
          const request = { market: args.market as string };
          const submissionOrderId = await hyperliquid.closePosition(request.market);
          const verification = await hyperliquid.getOrder(submissionOrderId);
          const positions = await hyperliquid.getPositions();
          result = {
            tool: 'hyperliquid_close_position',
            request,
            submission: { orderId: submissionOrderId, status: 'submitted' },
            verification,
            warnings: [],
            positions,
          };
          break;
        }

        case 'hyperliquid_get_order': {
          const hyperliquid = await this.agent.hyperliquid();
          result = await hyperliquid.getOrder(args.orderId as string);
          break;
        }

        case 'hyperliquid_get_orders': {
          const hyperliquid = await this.agent.hyperliquid();
          const orders = await hyperliquid.getOpenOrders();
          result = { count: orders.length, orders };
          break;
        }

        case 'hyperliquid_get_trades': {
          const hyperliquid = await this.agent.hyperliquid();
          const trades = await hyperliquid.getTrades();
          result = { count: trades.length, trades };
          break;
        }

        case 'find_perp_market': {
          const match = await this.agent.findPerpMarket(args.ticker as string);
          result = match;
          break;
        }

        // Li.Fi cross-chain liquidity SDK tools (v0.8.0)
        case 'check_bridge_status': {
          result = await this.agent.checkBridgeStatus({
            txHash: args.txHash as string,
            bridge: args.bridge as string | undefined,
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
          });
          break;
        }

        case 'lifi_swap_quote': {
          const chainId = args.chainId as number;
          const quote = await this.agent.getSwapQuote({
            fromChainId: chainId,
            toChainId: chainId,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
            routeStrategy: args.routeStrategy as 'recommended' | 'minimum_slippage' | 'minimum_execution_time' | 'fastest_route' | 'minimum_completion_time' | undefined,
            routeOrder: args.routeOrder as 'FASTEST' | 'CHEAPEST' | undefined,
            preset: args.preset as string | undefined,
            maxPriceImpact: args.maxPriceImpact as number | undefined,
            skipSimulation: args.skipSimulation as boolean | undefined,
          });
          result = {
            id: quote.id,
            fromChainId: quote.fromChainId,
            toChainId: quote.toChainId,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            estimatedGas: quote.estimatedGas,
            estimatedTime: quote.estimatedTime,
            tool: quote.tool,
          };
          break;
        }

        case 'lifi_swap': {
          const chainId = args.chainId as number;
          const request = {
            fromChainId: chainId,
            toChainId: chainId,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
            routeStrategy: args.routeStrategy as 'recommended' | 'minimum_slippage' | 'minimum_execution_time' | 'fastest_route' | 'minimum_completion_time' | undefined,
            routeOrder: args.routeOrder as 'FASTEST' | 'CHEAPEST' | undefined,
            preset: args.preset as string | undefined,
            maxPriceImpact: args.maxPriceImpact as number | undefined,
            skipSimulation: args.skipSimulation as boolean | undefined,
          };
          const submission = await this.agent.swapDetailed(request);
          result = {
            tool: 'lifi_swap',
            request,
            submission: {
              txHash: submission.txHash,
              status: submission.status,
              routeId: submission.routeId,
              tool: submission.tool,
            },
            verification: {
              sourceReceiptStatus: submission.sourceReceiptStatus,
              transferStatus: submission.transferStatus ?? null,
              balances: submission.balances ?? null,
            },
            warnings: submission.warnings,
            raw: submission,
          };
          break;
        }

        case 'lifi_get_tokens': {
          const tokens = await this.agent.getTokens(args.chainIds as number[]);
          result = { tokens };
          break;
        }

        case 'lifi_get_token': {
          result = await this.agent.getToken(args.chainId as number, args.tokenAddress as string);
          break;
        }

        case 'lifi_get_chains': {
          const chains = await this.agent.getLiFiChains(args.chainTypes as string[] | undefined);
          result = { count: chains.length, chains };
          break;
        }

        case 'lifi_get_tools': {
          result = await this.agent.getLiFiTools();
          break;
        }

        case 'lifi_gas_prices': {
          result = await this.agent.getGasPrices();
          break;
        }

        case 'lifi_gas_suggestion': {
          result = await this.agent.getGasSuggestion(args.chainId as number);
          break;
        }

        case 'lifi_get_connections': {
          const connections = await this.agent.getLiFiConnections({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: args.fromToken as string | undefined,
            toToken: args.toToken as string | undefined,
          });
          result = { count: connections.length, connections };
          break;
        }

        case 'lifi_compose': {
          const request = {
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toVaultToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
            routeStrategy: args.routeStrategy as 'recommended' | 'minimum_slippage' | 'minimum_execution_time' | 'fastest_route' | 'minimum_completion_time' | undefined,
            routeOrder: args.routeOrder as 'FASTEST' | 'CHEAPEST' | undefined,
            preset: args.preset as string | undefined,
            maxPriceImpact: args.maxPriceImpact as number | undefined,
            skipSimulation: args.skipSimulation as boolean | undefined,
          };
          const submission = await this.agent.bridgeTokensDetailed(request);
          result = {
            tool: 'lifi_compose',
            request,
            submission: {
              txHash: submission.txHash,
              status: submission.status,
              routeId: submission.routeId,
              tool: submission.tool,
            },
            verification: {
              sourceReceiptStatus: submission.sourceReceiptStatus,
              transferStatus: submission.transferStatus ?? null,
              balances: submission.balances ?? null,
            },
            warnings: submission.warnings,
            raw: submission,
          };
          break;
        }

        // Platform CLI tools (v0.6.0)
        case 'platform_cli_available': {
          const cli = await this.agent.platformCLI();
          const available = await cli.isAvailable();
          if (available) {
            const version = await cli.getVersion();
            result = { available: true, version };
          } else {
            result = { available: false, install: 'go install github.com/ava-labs/platform-cli@latest' };
          }
          break;
        }

        case 'subnet_create': {
          const cli = await this.agent.platformCLI();
          const subnetResult = await cli.createSubnet();
          result = subnetResult;
          break;
        }

        case 'subnet_convert_l1': {
          const cli = await this.agent.platformCLI();
          const convertResult = await cli.convertSubnetToL1({
            subnetId: args.subnetId as string,
            chainId: args.chainId as string,
            validators: args.validators as string | undefined,
            managerAddress: args.managerAddress as string | undefined,
            mockValidator: args.mockValidator as boolean | undefined,
          });
          result = { txId: convertResult.txId, output: convertResult.stdout };
          break;
        }

        case 'subnet_transfer_ownership': {
          const cli = await this.agent.platformCLI();
          const ownerResult = await cli.transferSubnetOwnership(
            args.subnetId as string,
            args.newOwner as string,
          );
          result = { txId: ownerResult.txId, output: ownerResult.stdout };
          break;
        }

        case 'add_validator': {
          const cli = await this.agent.platformCLI();
          const valResult = await cli.addValidator({
            nodeId: args.nodeId as string,
            stakeAvax: args.stakeAvax as number,
            durationHours: args.durationHours as number | undefined,
            delegationFee: args.delegationFee as number | undefined,
            blsPublicKey: args.blsPublicKey as string | undefined,
            blsPop: args.blsPop as string | undefined,
            nodeEndpoint: args.nodeEndpoint as string | undefined,
          });
          result = { txId: valResult.txId, output: valResult.stdout };
          break;
        }

        case 'l1_register_validator': {
          const cli = await this.agent.platformCLI();
          const regResult = await cli.registerL1Validator(
            args.balanceAvax as number,
            args.pop as string,
            args.message as string,
          );
          result = regResult;
          break;
        }

        case 'l1_add_balance': {
          const cli = await this.agent.platformCLI();
          const balResult = await cli.addL1ValidatorBalance(
            args.validationId as string,
            args.balanceAvax as number,
          );
          result = { txId: balResult.txId, output: balResult.stdout };
          break;
        }

        case 'l1_disable_validator': {
          const cli = await this.agent.platformCLI();
          const disableResult = await cli.disableL1Validator(args.validationId as string);
          result = { txId: disableResult.txId, output: disableResult.stdout };
          break;
        }

        case 'node_info': {
          const cli = await this.agent.platformCLI();
          result = await cli.getNodeInfo(args.ip as string);
          break;
        }

        case 'pchain_send': {
          const cli = await this.agent.platformCLI();
          const sendResult = await cli.sendOnPChain({
            to: args.to as string,
            amountAvax: args.amountAvax as number,
          });
          result = { txId: sendResult.txId, output: sendResult.stdout };
          break;
        }

        // Economy tools (v1.0.0)
        case 'get_budget':
          result = this.agent.getBudgetStatus() ?? { message: 'No spending policy set' };
          break;

        case 'set_policy': {
          if (args.remove === true) {
            if (args.confirm !== 'remove') {
              throw new EvalancheError(
                'Policy removal requires confirm="remove"',
                EvalancheErrorCode.POLICY_VIOLATION,
              );
            }
            this.agent.setPolicy(null);
            result = { success: true, message: 'Policy removed' };
          } else {
            const policyFields = [
              'maxPerTransaction',
              'maxPerHour',
              'maxPerDay',
              'allowlistedChains',
              'allowlistedContracts',
              'simulateBeforeSend',
              'dryRun',
            ];
            const hasPolicyField = policyFields.some((field) => args[field] !== undefined);
            if (!hasPolicyField) {
              throw new EvalancheError(
                'set_policy requires policy fields, or remove=true with confirm="remove"',
                EvalancheErrorCode.INVALID_CONFIG,
              );
            }
            this.agent.setPolicy({
              maxPerTransaction: args.maxPerTransaction as string | undefined,
              maxPerHour: args.maxPerHour as string | undefined,
              maxPerDay: args.maxPerDay as string | undefined,
              allowlistedChains: args.allowlistedChains as number[] | undefined,
              allowlistedContracts: args.allowlistedContracts as Array<{ address: string; selectors?: string[] }> | undefined,
              simulateBeforeSend: args.simulateBeforeSend as boolean | undefined,
              dryRun: args.dryRun as boolean | undefined,
            });
            result = { success: true, policy: this.agent.getPolicy() };
          }
          break;
        }

        case 'simulate_tx': {
          const simResult = await this.agent.simulateTransaction({
            to: args.to as string,
            value: args.value as string | undefined,
            data: args.data as string | undefined,
          });
          result = simResult;
          break;
        }

        case 'register_service': {
          const agentIdentityConfig = this.config.identity;
          const agentId = agentIdentityConfig?.agentId ?? this.agent.address;
          this.discovery.register({
            agentId,
            capability: args.capability as string,
            description: args.description as string,
            endpoint: args.endpoint as string,
            pricePerCall: args.pricePerCall as string,
            chainId: args.chainId as number,
            tags: args.tags as string[] | undefined,
            registeredAt: Date.now(),
          });
          result = { success: true, agentId, capability: args.capability };
          break;
        }

        case 'discover_agents': {
          const services = await this.discovery.search({
            capability: args.capability as string | undefined,
            minReputation: args.minReputation as number | undefined,
            maxPrice: args.maxPrice as string | undefined,
            chainIds: args.chainIds as number[] | undefined,
            tags: args.tags as string[] | undefined,
            limit: args.limit as number | undefined,
          });
          result = { count: services.length, services };
          break;
        }

        case 'resolve_agent_profile': {
          const profile = await this.discovery.resolve(args.agentId as string);
          result = profile;
          break;
        }

        case 'serve_endpoint': {
          const responseContent = (args.responseTemplate as string) ?? JSON.stringify({ status: 'ok' });
          this.serviceHost.serve({
            path: args.path as string,
            price: args.price as string,
            currency: args.currency as string,
            chainId: args.chainId as number,
            handler: async () => responseContent,
          });
          result = { success: true, path: args.path, price: args.price, currency: args.currency };
          break;
        }

        case 'get_revenue':
          result = this.serviceHost.getRevenue();
          break;

        case 'list_services':
          result = { endpoints: this.serviceHost.listEndpoints(), count: this.serviceHost.listEndpoints().length };
          break;

        // ── Phase 4: Negotiation & Settlement ──

        case 'negotiate_task': {
          const action = args.action as string;
          switch (action) {
            case 'propose': {
              const proposalId = this.negotiation.propose({
                fromAgentId: args.fromAgentId as string,
                toAgentId: args.toAgentId as string,
                toAddress: args.toAddress as string | undefined,
                task: args.task as string,
                price: args.price as string,
                chainId: args.chainId as number,
                ttlMs: args.ttlMs as number | undefined,
              });
              result = { proposalId, status: 'pending', message: 'Proposal created' };
              break;
            }
            case 'accept': {
              const proposal = this.negotiation.accept(args.proposalId as string);
              result = { proposalId: args.proposalId, status: proposal.status, agreedPrice: this.negotiation.getAgreedPrice(args.proposalId as string) };
              break;
            }
            case 'counter': {
              const proposal = this.negotiation.counter(args.proposalId as string, args.counterPrice as string);
              result = { proposalId: args.proposalId, status: proposal.status, counterPrice: proposal.counterPrice };
              break;
            }
            case 'reject': {
              const proposal = this.negotiation.reject(args.proposalId as string);
              result = { proposalId: args.proposalId, status: proposal.status };
              break;
            }
            default:
              throw new EvalancheError(`Unknown negotiate action: ${action}. Use propose, accept, counter, or reject.`, EvalancheErrorCode.NEGOTIATION_ERROR);
          }
          break;
        }

        case 'settle_payment': {
          const settlement = await this.settlement.settle({
            proposalId: args.proposalId as string,
            recipientAddress: args.recipientAddress as string | undefined,
            reputationScore: (args.reputationScore as number) ?? 50,
          });
          result = {
            proposalId: args.proposalId,
            status: settlement.proposal.status,
            paidAmount: settlement.paidAmount,
            paymentTxHash: settlement.paymentTxHash,
            reputationTxHash: settlement.reputationTxHash,
          };
          break;
        }

        case 'get_agreements': {
          if (args.proposalId) {
            const proposal = this.negotiation.get(args.proposalId as string);
            result = proposal ?? { error: 'Proposal not found' };
          } else {
            const list = this.negotiation.list({
              status: args.status as 'pending' | 'accepted' | 'countered' | 'rejected' | 'settled' | 'expired' | undefined,
              agentId: args.agentId as string | undefined,
            });
            result = { proposals: list, count: list.length };
          }
          break;
        }

        // ── Phase 5: Persistent Memory ──

        case 'record_interaction': {
          const id = this.memory.record({
            type: args.type as Parameters<AgentMemory['record']>[0]['type'],
            counterpartyId: args.counterpartyId as string,
            amount: args.amount as string | undefined,
            chainId: args.chainId as number | undefined,
            txHash: args.txHash as string | undefined,
            reputationScore: args.reputationScore as number | undefined,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          result = { interactionId: id, recorded: true };
          break;
        }

        case 'get_transaction_history': {
          const interactions = this.memory.query({
            type: args.type as Parameters<AgentMemory['record']>[0]['type'] | undefined,
            counterpartyId: args.counterpartyId as string | undefined,
            since: args.since as number | undefined,
            until: args.until as number | undefined,
            chainId: args.chainId as number | undefined,
            limit: args.limit as number | undefined,
          });
          result = { interactions, count: interactions.length };
          break;
        }

        case 'get_relationships': {
          if (args.capability) {
            const preferred = this.memory.getPreferredAgents(
              args.capability as string,
              args.limit as number | undefined,
            );
            result = { preferredAgents: preferred, count: preferred.length };
          } else if (args.agentId) {
            const rel = this.memory.getRelationship(args.agentId as string);
            result = rel ?? { agentId: args.agentId, error: 'No interactions found' };
          } else {
            const all = this.memory.getAllRelationships();
            result = { relationships: all, count: all.length };
          }
          break;
        }

        // ── Phase 7: Interop — ERC-8004 Identity Resolution ──

        case 'resolve_agent_registration': {
          const registration = await this.interopResolver.resolveAgent(
            args.agentId as string,
            args.agentRegistry as string | undefined,
          );
          result = registration;
          break;
        }

        case 'get_agent_services': {
          const services = await this.interopResolver.getServiceEndpoints(
            args.agentId as string,
            args.agentRegistry as string | undefined,
          );
          result = { agentId: args.agentId, services, count: services.length };
          break;
        }

        case 'get_agent_wallet': {
          const wallet = await this.interopResolver.resolveAgentWallet(
            args.agentId as string,
            args.agentRegistry as string | undefined,
          );
          result = { agentId: args.agentId, wallet };
          break;
        }

        case 'verify_agent_endpoint': {
          const verification = await this.interopResolver.verifyEndpointBinding(
            args.agentId as string,
            args.endpoint as string,
            args.agentRegistry as string | undefined,
          );
          result = { agentId: args.agentId, endpoint: args.endpoint, ...verification };
          break;
        }

        case 'resolve_by_wallet': {
          const agentId = await this.interopResolver.resolveByWallet(
            args.address as string,
            args.agentRegistry as string | undefined,
          );
          result = agentId
            ? { address: args.address, agentId }
            : { address: args.address, agentId: null, message: 'No agent found for this address' };
          break;
        }

        // ── DeFi: Liquid Staking ──────────────────────────────────────────

        case 'savax_stake_quote': {
          const resolution = this.resolveSavaxTarget(args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          result = {
            resolution,
            quote: await defi.staking.sAvaxStakeQuote(args.amountAvax as string),
          };
          break;
        }

        case 'savax_stake': {
          const resolution = this.resolveSavaxTarget(args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          const txResult = await defi.staking.sAvaxStake(
            args.amountAvax as string,
            args.slippageBps as number | undefined,
          );
          result = { resolution, hash: txResult.hash, status: txResult.receipt.status };
          break;
        }

        case 'savax_unstake_quote': {
          const resolution = this.resolveSavaxTarget(args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          const quote = await defi.staking.sAvaxUnstakeQuote(
            args.shares as string,
            args.slippageBps as number | undefined,
          );
          result = {
            resolution,
            request: {
              shares: args.shares as string,
              slippageBps: args.slippageBps as number | undefined,
            },
            quote,
          };
          break;
        }

        case 'savax_unstake': {
          const resolution = this.resolveSavaxTarget(args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          const forceDelayed = (args.forceDelayed as boolean) ?? false;
          let txResult;
          if (forceDelayed) {
            txResult = await defi.staking.sAvaxUnstakeDelayed(args.shares as string);
          } else {
            txResult = await defi.staking.sAvaxUnstakeInstant(
              args.shares as string,
              args.slippageBps as number | undefined,
            );
          }
          result = { resolution, hash: txResult.hash, status: txResult.receipt.status };
          break;
        }

        // ── DeFi: EIP-4626 Vaults ────────────────────────────────────────

        case 'vault_info': {
          const resolution = this.resolveVaultTarget(args.vaultAddress as string, args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          result = {
            resolution,
            vault: await defi.vaults.vaultInfo(resolution.address),
          };
          break;
        }

        case 'vault_deposit_quote': {
          const resolution = this.resolveVaultTarget(args.vaultAddress as string, args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          result = {
            resolution,
            quote: await defi.vaults.depositQuote(
              resolution.address,
              args.assetAmount as string,
              args.assetDecimals as number | undefined,
            ),
          };
          break;
        }

        case 'vault_deposit': {
          const resolution = this.resolveVaultTarget(args.vaultAddress as string, args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          const txResult = await defi.vaults.deposit(
            resolution.address,
            args.assetAmount as string,
            args.assetDecimals as number | undefined,
          );
          result = { resolution, hash: txResult.hash, status: txResult.receipt.status };
          break;
        }

        case 'vault_withdraw_quote': {
          const resolution = this.resolveVaultTarget(args.vaultAddress as string, args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          result = {
            resolution,
            quote: await defi.vaults.withdrawQuote(
              resolution.address,
              args.shareAmount as string,
              args.shareDecimals as number | undefined,
            ),
          };
          break;
        }

        case 'vault_withdraw': {
          const resolution = this.resolveVaultTarget(args.vaultAddress as string, args.network as string | undefined);
          const defi = this.getDefiAgentForNetwork(resolution.network).defi();
          const txResult = await defi.vaults.withdraw(
            resolution.address,
            args.shareAmount as string,
            args.shareDecimals as number | undefined,
          );
          result = { resolution, hash: txResult.hash, status: txResult.receipt.status };
          break;
        }
        // ─── CoinGecko Market Data ───
        case 'cg_price':
          result = await this.coingecko.price({
            ids: (args.ids ?? args.symbols ?? '') as string,
          });
          break;

        case 'cg_trending':
          result = await this.coingecko.trending();
          break;

        case 'cg_top_movers':
          result = await this.coingecko.topGainersLosers({
            duration: args.duration as string | undefined,
            topCoins: args.topCoins as string | undefined,
          });
          break;

        case 'cg_markets':
          result = await this.coingecko.markets({
            perPage: args.total as number | undefined,
            vsCurrency: args.vs as string | undefined,
            order: args.order as string | undefined,
          });
          break;

        case 'cg_search':
          result = await this.coingecko.search(
            args.query as string,
          );
          break;

        case 'cg_history':
          result = await this.coingecko.history({
            id: args.id as string,
            date: (args.date ?? args.from) as string,
          });
          break;

        case 'cg_status':
          result = await this.coingecko.status();
          break;

        // ─── Polymarket ───
        case 'pm_search':
          result = await this.getPolymarket().searchMarkets(
            String(args.query ?? ''),
            (args.limit as number | undefined) ?? 10,
          );
          break;

        case 'pm_market': {
          const conditionId = this.requirePolymarketString(args, 'conditionId', 'pm_market');
          result = await this.inspectPolymarketMarket(conditionId);
          break;
        }

        case 'pm_positions': {
          const wallet = (args.walletAddress as string) || this.agent.address;
          const positions = await this.fetchPolymarketPositions(wallet);
          result = { walletAddress: wallet, count: positions.length, positions };
          break;
        }

        case 'pm_orderbook': {
          const tokenId = this.requirePolymarketString(args, 'tokenId', 'pm_orderbook');
          result = await this.inspectPolymarketOrderBook(tokenId);
          break;
        }

        case 'pm_balances': {
          const tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          result = await this.getPolymarketVenueBalances(tokenId);
          break;
        }

        case 'pm_order': {
          const orderId = this.requirePolymarketString(args, 'orderId', 'pm_order');
          const tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          const walletAddress = typeof args.walletAddress === 'string' && args.walletAddress.trim().length > 0
            ? args.walletAddress.trim()
            : undefined;
          const conditionId = typeof args.conditionId === 'string' && args.conditionId.trim().length > 0
            ? args.conditionId.trim()
            : undefined;
          const outcome = typeof args.outcome === 'string'
            ? this.normalizePolymarketOutcome(args.outcome, 'pm_order')
            : undefined;
          result = await this.reconcilePolymarketVenue({ orderId, tokenId, walletAddress, conditionId, outcome });
          break;
        }

        case 'pm_cancel_order': {
          const orderId = this.requirePolymarketString(args, 'orderId', 'pm_cancel_order');
          let tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          const conditionId = typeof args.conditionId === 'string' && args.conditionId.trim().length > 0
            ? args.conditionId.trim()
            : undefined;
          const outcome = typeof args.outcome === 'string'
            ? this.normalizePolymarketOutcome(args.outcome, 'pm_cancel_order')
            : undefined;
          if (!tokenId && conditionId && outcome) {
            const resolution = await this.resolvePolymarketMarketToken(conditionId, outcome);
            if (resolution.ok) tokenId = resolution.tokenId;
          }
          const authed = await this.getAuthedClobClient();
          await authed.cancelOrder(orderId);
          const verification = await this.reconcilePolymarketVenue({
            orderId,
            tokenId,
            conditionId,
            outcome,
          });
          result = {
            tool: 'pm_cancel_order',
            request: { orderId, tokenId, conditionId, outcome },
            submission: { orderId, status: 'canceled' },
            verification,
            warnings: [],
          };
          break;
        }

        case 'pm_open_orders': {
          let tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          if (!tokenId && typeof args.conditionId === 'string' && typeof args.outcome === 'string') {
            const resolution = await this.resolvePolymarketMarketToken(
              args.conditionId.trim(),
              this.normalizePolymarketOutcome(args.outcome, 'pm_open_orders'),
            );
            if (!resolution.ok) throw new Error(resolution.error.message);
            tokenId = resolution.tokenId;
          }
          const authed = await this.getAuthedClobClient();
          const openOrders = typeof authed.getOpenOrders === 'function'
            ? await authed.getOpenOrders(tokenId)
            : [];
          result = {
            walletAddress: this.agent.address,
            tokenId: tokenId ?? null,
            count: Array.isArray(openOrders) ? openOrders.length : 0,
            orders: Array.isArray(openOrders) ? openOrders : [],
          };
          break;
        }

        case 'pm_trades': {
          let tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          if (!tokenId && typeof args.conditionId === 'string' && typeof args.outcome === 'string') {
            const resolution = await this.resolvePolymarketMarketToken(
              args.conditionId.trim(),
              this.normalizePolymarketOutcome(args.outcome, 'pm_trades'),
            );
            if (!resolution.ok) throw new Error(resolution.error.message);
            tokenId = resolution.tokenId;
          }
          const authed = await this.getAuthedClobClient();
          const trades = typeof authed.getTrades === 'function'
            ? await authed.getTrades(tokenId)
            : [];
          result = {
            walletAddress: this.agent.address,
            tokenId: tokenId ?? null,
            count: Array.isArray(trades) ? trades.length : 0,
            trades: Array.isArray(trades) ? trades : [],
          };
          break;
        }

        case 'pm_approve': {
          // Approve maxUint256 so the CLOB can pull wallet-side USDC.e when needed,
          // and also approve pUSD spenders for already-deposited venue collateral.
          const txHash = await this.approveUsdcToCLOB();
          const collateralTxHashes = await this.approvePusdCollateralSpenders().catch(() => []);

          // Update the CLOB's off-chain record to match the on-chain approval.
          const authedApprove = await this.getAuthedClobClient();
          try {
            await authedApprove.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
          } catch (e) {
            // Non-fatal: the on-chain approval is what matters; the off-chain
            // record can be stale and will sync on the next read.
          }

          result = {
            approved: true,
            txHash,
            collateralTxHashes,
            note: collateralTxHashes.length > 0
              ? 'Approved both wallet-side USDC.e -> CLOB and pUSD -> Polymarket spenders.'
              : 'Approved wallet-side USDC.e -> CLOB. No new pUSD spender approvals were needed.',
          };
          break;
        }

        case 'pm_deposit': {
          // Deposit USDC into the Polymarket CLOB contract.
          // Flow: (1) approve CLOB to pull USDC from wallet → (2) registerCollateral to credit CLOB balance
          const rawAmount = parseFloat(args.amountUSDC as string);
          if (isNaN(rawAmount) || rawAmount <= 0) {
            throw new Error(`amountUSDC must be a positive number. Got: ${args.amountUSDC}`);
          }

          const { createWalletClient, http, parseUnits, formatUnits } = await import('viem');
          const { polygon } = await import('viem/chains');
          const { privateKeyToAccount } = await import('viem/accounts');
          const { Evalanche } = await import('../index.js');

          let pk = this.agent.wallet.privateKey;
          if (!pk) throw new Error('Agent wallet has no privateKey');
          if (!pk.startsWith('0x')) pk = `0x${pk}`;

          const account = privateKeyToAccount(pk as `0x${string}`);
          const walletClient = createWalletClient({
            account,
            chain: polygon,
            transport: http(),
          });
          const publicClient = (await import('viem')).createPublicClient({
            chain: polygon,
            transport: http(),
          });

          // Polymarket CLOB contract and USDC on Polygon
          const CLOB_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
          const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
          const POLYGON_NATIVE_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
          const USDC_DECIMALS = 6;
          const depositAmount = parseUnits(String(rawAmount), USDC_DECIMALS);

          // Step 1: check current on-chain allowance and wallet balances
          let [allowanceRaw, balanceRaw, nativeBalanceRaw] = await Promise.all([
            publicClient.readContract({
              address: USDC_CONTRACT,
              abi: [{ name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } as any],
              functionName: 'allowance',
              args: [account.address, CLOB_CONTRACT as `0x${string}`],
            }),
            publicClient.readContract({
              address: USDC_CONTRACT,
              abi: [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } as any],
              functionName: 'balanceOf',
              args: [account.address as `0x${string}`],
            }),
            publicClient.readContract({
              address: POLYGON_NATIVE_USDC,
              abi: [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } as any],
              functionName: 'balanceOf',
              args: [account.address as `0x${string}`],
            }),
          ]);
          let currentAllowance = (allowanceRaw as bigint) ?? 0n;
          let usdcBalance = (balanceRaw as bigint) ?? 0n;
          const nativeUsdcBalance = (nativeBalanceRaw as bigint) ?? 0n;

          if (usdcBalance < depositAmount) {
            const deficit = depositAmount - usdcBalance;
            const autoFundAmountRaw = deficit + parseUnits('0.02', USDC_DECIMALS);
            if (nativeUsdcBalance < autoFundAmountRaw) {
              throw new Error(
                `Insufficient USDC balance. Have: $${formatUnits(usdcBalance, USDC_DECIMALS)}, ` +
                `Need: $${rawAmount}. Native Polygon USDC available: $${formatUnits(nativeUsdcBalance, USDC_DECIMALS)}.`,
              );
            }

            const agent = new (Evalanche as any)({ privateKey: pk, network: 'polygon' });
            await agent.bridgeTokens({
              fromChainId: 137,
              toChainId: 137,
              fromToken: POLYGON_NATIVE_USDC,
              toToken: USDC_CONTRACT,
              fromAmount: formatUnits(autoFundAmountRaw, USDC_DECIMALS),
              fromAddress: account.address,
              toAddress: account.address,
              slippage: 0.03,
            });

            [allowanceRaw, balanceRaw] = await Promise.all([
              publicClient.readContract({
                address: USDC_CONTRACT,
                abi: [{ name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } as any],
                functionName: 'allowance',
                args: [account.address, CLOB_CONTRACT as `0x${string}`],
              }),
              publicClient.readContract({
                address: USDC_CONTRACT,
                abi: [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } as any],
                functionName: 'balanceOf',
                args: [account.address as `0x${string}`],
              }),
            ]);
            currentAllowance = (allowanceRaw as bigint) ?? 0n;
            usdcBalance = (balanceRaw as bigint) ?? 0n;
          }

          if (usdcBalance < depositAmount) {
            throw new Error(
              `Insufficient USDC balance after auto-fund. Have: $${formatUnits(usdcBalance, USDC_DECIMALS)}, ` +
              `Need: $${rawAmount}.`,
            );
          }

          // Step 2: approve CLOB to pull USDC if needed
          let approveHash: string | null = null;
          if (currentAllowance < depositAmount) {
            const maxUint = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
            approveHash = await walletClient.writeContract({
              address: USDC_CONTRACT,
              abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' } as any],
              functionName: 'approve',
              args: [CLOB_CONTRACT as `0x${string}`, maxUint],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash as `0x${string}` });
          }

          // Step 3: call registerCollateral on the CLOB contract to credit CLOB balance
          let depositHash: string | null = null;
          let depositSuccess = false;
          try {
            depositHash = await walletClient.writeContract({
              address: CLOB_CONTRACT,
              abi: [{ name: 'registerCollateral', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' } as any],
              functionName: 'registerCollateral',
              args: [depositAmount as bigint],
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash as `0x${string}` });
            depositSuccess = receipt.status === 'success';
          } catch (err: any) {
            const msg = err?.shortMessage ?? err?.message ?? String(err);
            throw new Error(
              `pm_deposit registerCollateral failed: ${msg}. ` +
              `The CLOB contract may reject deposits that exceed position limits.`,
            );
          }

          // Step 4: update CLOB's off-chain balance record and sync pUSD spender approvals
          const authed = await this.getAuthedClobClient();
          try {
            await authed.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
          } catch (e) {
            // Non-fatal — on-chain deposit is confirmed
          }
          const collateralTxHashes = await this.approvePusdCollateralSpenders(rawAmount).catch(() => []);

          result = {
            deposited: depositSuccess,
            amountUSDC: rawAmount,
            depositAmountRaw: depositAmount.toString(),
            txHash: depositHash,
            approveTxHash: approveHash,
            collateralTxHashes,
            CLOBContract: CLOB_CONTRACT,
            note: 'registerCollateral called — USDC now in CLOB collateral balance and pUSD spender approvals were synced',
          };
          break;
        }

        case 'pm_withdraw': {
          const amountUSDC = this.requirePolymarketString(args, 'amountUSDC', 'pm_withdraw');
          const toChainId = this.requirePolymarketString(args, 'toChainId', 'pm_withdraw');
          const toTokenAddress = this.requirePolymarketString(args, 'toTokenAddress', 'pm_withdraw');
          const recipientAddr = this.requirePolymarketString(args, 'recipientAddr', 'pm_withdraw');
          const withdrawal = await this.getPolymarket().withdrawUsdc({
            amountUSDC,
            toChainId,
            toTokenAddress,
            recipientAddr,
          });
          result = {
            tool: 'pm_withdraw',
            request: {
              amountUSDC: withdrawal.amountUSDC,
              toChainId: withdrawal.toChainId,
              toTokenAddress: withdrawal.toTokenAddress,
              recipientAddr: withdrawal.recipientAddr,
            },
            quote: withdrawal.quote,
            submission: {
              txHash: withdrawal.txHash,
              status: withdrawal.receiptStatus,
              fromChainId: withdrawal.fromChainId,
              fromTokenAddress: withdrawal.fromTokenAddress,
              bridgeAddress: withdrawal.bridgeAddress,
              bridgeAddresses: withdrawal.bridgeAddresses,
              bridgeNote: withdrawal.bridgeNote,
              amountBaseUnit: withdrawal.amountBaseUnit,
            },
            verification: {
              blockNumber: withdrawal.blockNumber,
              usdcBefore: withdrawal.usdcBefore,
              usdcAfter: withdrawal.usdcAfter,
              usdcDelta: withdrawal.usdcDelta,
              bridgeTransaction: withdrawal.bridgeTransaction,
              bridgeTransactions: withdrawal.bridgeStatus?.transactions ?? [],
            },
            withdrawn: withdrawal.receiptStatus === 'success',
            txHash: withdrawal.txHash,
            bridgeStatus: withdrawal.bridgeTransaction?.status ?? null,
          };
          break;
        }

        case 'pm_preflight': {
          const action = this.requirePolymarketString(args, 'action', 'pm_preflight') as 'buy' | 'sell' | 'limit_sell';
          if (!['buy', 'sell', 'limit_sell'].includes(action)) {
            throw new Error(`pm_preflight action must be one of: buy, sell, limit_sell.`);
          }
          const conditionId = this.requirePolymarketString(args, 'conditionId', 'pm_preflight');
          const outcome = this.normalizePolymarketOutcome(args.outcome, 'pm_preflight');
          const request: any = { action, conditionId, outcome };
          if (args.amountUSDC !== undefined) request.amountUSDC = this.parsePolymarketPositiveNumber(args.amountUSDC, 'amountUSDC', 'pm_preflight');
          if (args.orderType !== undefined) request.orderType = this.requirePolymarketString(args, 'orderType', 'pm_preflight');
          if (args.limitPrice !== undefined) request.limitPrice = this.parsePolymarketPositiveNumber(args.limitPrice, 'limitPrice', 'pm_preflight', { zeroToOneExclusive: true });
          if (args.price !== undefined) request.price = this.parsePolymarketPositiveNumber(args.price, 'price', 'pm_preflight', { zeroToOneExclusive: true });
          if (args.shares !== undefined) request.shares = this.parsePolymarketPositiveNumber(args.shares, 'shares', 'pm_preflight');
          if (args.maxSlippagePct !== undefined) request.maxSlippagePct = this.parsePolymarketPositiveNumber(args.maxSlippagePct, 'maxSlippagePct', 'pm_preflight');
          if (args.postOnly !== undefined) request.postOnly = Boolean(args.postOnly);
          result = await this.runPolymarketPreflight(request);
          break;
        }

        case 'pm_diag': {
          throw new Error('pm_diag was removed. Use advertised read-only Polymarket tools plus pm_preflight/pm_reconcile.');
        }

        case 'pm_nonce_probe': {
          throw new Error('pm_nonce_probe was removed. Official Polymarket CLI manages order authentication and nonce handling.');
        }

        case 'pm_buy': {
          const conditionId = this.requirePolymarketString(args, 'conditionId', 'pm_buy');
          const outcome = this.normalizePolymarketOutcome(args.outcome, 'pm_buy');
          const amountUSDC = this.parsePolymarketPositiveNumber(args.amountUSDC, 'amountUSDC', 'pm_buy');
          const orderType = ((args.orderType as string | undefined) ?? 'market').toLowerCase() as 'market' | 'limit';
          if (orderType !== 'market' && orderType !== 'limit') {
            throw new Error(`pm_buy requires orderType to be 'market' or 'limit'.`);
          }
          const limitPrice = args.limitPrice !== undefined
            ? this.parsePolymarketPositiveNumber(args.limitPrice, 'limitPrice', 'pm_buy', { zeroToOneExclusive: true })
            : undefined;
          const preflight = await this.runPolymarketPreflight({
            action: 'buy',
            conditionId,
            outcome,
            amountUSDC,
            orderType,
            limitPrice,
          });
          if (preflight.verdict === 'blocked') {
            const reasons = preflight.checks
              .filter((check: { status: string }) => check.status === 'blocked')
              .map((check: { message: string }) => check.message)
              .join(' ');
            throw new Error(`pm_buy preflight failed: ${reasons}`);
          }
          const tokenId = preflight.tokenId as string;

          const authedBuy = await this.getAuthedClobClientV2();

          let orderResult: any;
          try {
            if (orderType === 'limit') {
              if (!limitPrice) throw new Error('pm_buy limit orders require limitPrice.');
              const size = amountUSDC / limitPrice;

              // Fetch market info for tick size and neg risk
              const marketInfo = await authedBuy.getMarket(conditionId);
              const tickSize = parseFloat(marketInfo?.minimum_tick_size ?? '0.01');
              const negRisk = marketInfo?.neg_risk ?? false;

              orderResult = await authedBuy.createAndPostOrder({
                tokenID: tokenId,
                price: limitPrice,
                side: 'buy',
                size,
                tickSize: String(tickSize),
                negRisk,
              }, undefined, 'GTC');
            } else {
              orderResult = await authedBuy.createAndPostMarketOrder({
                tokenID: tokenId,
                side: 'buy',
                amount: amountUSDC,
                orderType: 'FOK',
              });
            }

            // Surface CLOB rejections clearly
            const orderSuccess = orderResult?.success !== false && orderResult?.status !== 400 && orderResult?.error !== true;
            if (!orderSuccess) {
              const errorMsg =
                orderResult?.error?.message ??
                orderResult?.message ??
                orderResult?.reason ??
                orderResult?.msg ??
                JSON.stringify(orderResult).slice(0, 300);
              throw new Error(
                `pm_buy CLOB rejection: ${errorMsg}. ` +
                `tokenId=${tokenId.slice(0, 20)}..., amountUSDC=${amountUSDC}. ` +
                `Verify USDC allowance (pm_approve) and market status.`,
              );
            }
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            const respData = err?.response?.data ?? err?.response?._data ?? err?.data;
            const detail = respData ? ` [CLOB: ${JSON.stringify(respData).slice(0, 200)}]` : '';
            throw new Error(`pm_buy failed: ${msg}${detail}`);
          }

          const submissionFailure = this.getPolymarketSubmissionFailure(orderResult);
          const orderId = this.getPolymarketOrderId(orderResult);
          if (submissionFailure) {
            result = {
              tool: 'pm_buy',
              request: { conditionId, outcome, amountUSDC, orderType, limitPrice },
              preflight,
              submission: {
                orderID: orderId,
                status: submissionFailure.status ?? 'rejected',
                tokenId,
                outcome,
                amountUSDC,
                raw: orderResult,
                error: submissionFailure,
              },
              verification: this.buildSkippedPolymarketVerification(submissionFailure, tokenId),
              warnings: [...(preflight.warnings ?? []), submissionFailure.message],
              orderID: orderId,
              status: submissionFailure.status ?? 'rejected',
              tokenId,
              outcome,
              amountUSDC,
            };
            break;
          }

          const verification = await this.reconcilePolymarketVenue({
            orderId: orderId ?? undefined,
            tokenId,
            conditionId,
            outcome,
          });

          result = {
            tool: 'pm_buy',
            request: { conditionId, outcome, amountUSDC, orderType, limitPrice },
            preflight,
            submission: {
              orderID: orderId,
              status: orderResult?.status ?? 'SUBMITTED',
              tokenId,
              outcome,
              amountUSDC,
              raw: orderResult,
            },
            verification,
            warnings: preflight.warnings ?? [],
            orderID: orderId,
            status: orderResult?.status ?? 'SUBMITTED',
            tokenId,
            outcome,
            amountUSDC,
          };
          break;
        }

        case 'pm_sell': {
          const sellConditionId = this.requirePolymarketString(args, 'conditionId', 'pm_sell');
          const sellOutcome = this.normalizePolymarketOutcome(args.outcome, 'pm_sell');
          const sellAmountUSDC = this.parsePolymarketPositiveNumber(args.amountUSDC, 'amountUSDC', 'pm_sell');
          const sellMaxSlippagePct = (args.maxSlippagePct as number) ?? 1;
          const preflight = await this.runPolymarketPreflight({
            action: 'sell',
            conditionId: sellConditionId,
            outcome: sellOutcome,
            amountUSDC: sellAmountUSDC,
            maxSlippagePct: sellMaxSlippagePct,
          });
          if (preflight.verdict === 'blocked') {
            const reasons = preflight.checks
              .filter((check: { status: string }) => check.status === 'blocked')
              .map((check: { message: string }) => check.message)
              .join(' ');
            throw new Error(`pm_sell preflight failed: ${reasons}`);
          }

          const sellTokenId = preflight.tokenId as string;
          const bestBid = Number(preflight.orderbook?.summary?.bestBid ?? 0);
          const size = Number(preflight.estimates?.desiredShares ?? 0);
          const minAcceptablePrice = Number(preflight.estimates?.minAcceptablePrice ?? 0);
          const estimated = preflight.estimates?.fillEstimate ?? { averagePrice: 0, filledSize: 0, hasFullLiquidity: false };

          // Use authenticated client (getAuthedClobClient) and submit a protected immediate sell.
          const authed = await this.getAuthedClobClient();
          let marketInfo: any = null;
          try {
            marketInfo = await authed.getMarket(sellConditionId);
          } catch {
            // Fall back to default tick size / negRisk below.
          }

          const tickSizeRaw = String(marketInfo?.minimum_tick_size ?? '0.01');
          const tickSize = Math.max(parseFloat(tickSizeRaw) || 0.01, 0.0001);
          const negRisk = marketInfo?.neg_risk ?? false;
          const limitPrice = this.roundUpToTick(minAcceptablePrice, tickSize);
          const signedOrder = await authed.createOrder(
            {
              tokenID: sellTokenId,
              price: limitPrice,
              side: 'sell',
              size,
              feeRateBps: 0,
            },
            {
              tickSize: String(tickSize),
              negRisk,
            },
          );

          const orderRes = await authed.postOrder(signedOrder, 'FAK', false);

          // Attempt to read back filled price
          let avgFillPrice = estimated.averagePrice;
          let filledSize = estimated.filledSize;
          try {
            const filled = await authed.getOrder(orderRes.orderID ?? orderRes.orderIds?.[0]);
            if (filled) {
              avgFillPrice = filled.average_fill_price ?? estimated.averagePrice;
              filledSize = filled.size ?? estimated.filledSize;
            }
          } catch {
            // getOrder is best-effort; use estimates
          }

          if (avgFillPrice < minAcceptablePrice) {
            throw new Error(
              `Protected sell executed below the configured minimum acceptable price ` +
              `($${avgFillPrice.toFixed(4)} < $${minAcceptablePrice.toFixed(4)}). ` +
              `The sell was rejected as unsafe.`,
            );
          }

          // If postOrder returned an error, surface it clearly
          if (orderRes?.success === false || orderRes?.status === 400) {
            const errorMsg =
              orderRes?.error?.message ??
              orderRes?.message ??
              orderRes?.reason ??
              JSON.stringify(orderRes?.error ?? orderRes).slice(0, 300);
            throw new Error(
              `pm_sell CLOB rejection: ${errorMsg}. ` +
              `This usually means the CLOB market is inactive or the order ` +
              `violates market constraints (tick size, min size, etc). ` +
              `Use pm_limit_sell to post a GTC order instead.`,
            );
          }

          const submissionFailure = this.getPolymarketSubmissionFailure(orderRes);
          const orderId = this.getPolymarketOrderId(orderRes);
          if (submissionFailure) {
            result = {
              tool: 'pm_sell',
              request: {
                conditionId: sellConditionId,
                outcome: sellOutcome,
                amountUSDC: sellAmountUSDC,
                maxSlippagePct: sellMaxSlippagePct,
              },
              preflight,
              submission: {
                orderID: orderId,
                status: submissionFailure.status ?? 'rejected',
                tokenId: sellTokenId,
                outcome: sellOutcome,
                size: filledSize,
                averageFillPrice: avgFillPrice,
                totalUSDC: filledSize * avgFillPrice,
                proceedsTargetUSDC: sellAmountUSDC,
                raw: orderRes,
                error: submissionFailure,
              },
              verification: this.buildSkippedPolymarketVerification(submissionFailure, sellTokenId),
              warnings: [...(preflight.warnings ?? []), submissionFailure.message],
              orderID: orderId,
              status: submissionFailure.status ?? 'rejected',
              tokenId: sellTokenId,
              outcome: sellOutcome,
              size: filledSize,
              averageFillPrice: avgFillPrice,
              totalUSDC: filledSize * avgFillPrice,
              proceedsTargetUSDC: sellAmountUSDC,
              bestBidAtTime: bestBid,
              estimatedAveragePrice: estimated.averagePrice,
              minAcceptablePrice,
              protectedByLimitOrder: true,
              orderType: 'FAK',
              limitPrice,
            };
            break;
          }

          const verification = await this.reconcilePolymarketVenue({
            orderId: orderId ?? undefined,
            tokenId: sellTokenId,
            conditionId: sellConditionId,
            outcome: sellOutcome,
          });

          result = {
            tool: 'pm_sell',
            request: {
              conditionId: sellConditionId,
              outcome: sellOutcome,
              amountUSDC: sellAmountUSDC,
              maxSlippagePct: sellMaxSlippagePct,
            },
            preflight,
            submission: {
              orderID: orderId,
              status: orderRes?.status ?? 'submitted',
              tokenId: sellTokenId,
              outcome: sellOutcome,
              size: filledSize,
              averageFillPrice: avgFillPrice,
              totalUSDC: filledSize * avgFillPrice,
              proceedsTargetUSDC: sellAmountUSDC,
              raw: orderRes,
            },
            verification,
            warnings: preflight.warnings ?? [],
            orderID: orderId,
            status: orderRes?.status ?? 'submitted',
            tokenId: sellTokenId,
            outcome: sellOutcome,
            size: filledSize,
            averageFillPrice: avgFillPrice,
            totalUSDC: filledSize * avgFillPrice,
            proceedsTargetUSDC: sellAmountUSDC,
            bestBidAtTime: bestBid,
            estimatedAveragePrice: estimated.averagePrice,
            minAcceptablePrice,
            protectedByLimitOrder: true,
            orderType: 'FAK',
            limitPrice,
          };
          break;
        }


        case 'pm_raw_order': {
          throw new Error('pm_raw_order was removed. Use pm_buy, pm_sell, or pm_limit_sell with preflight and reconciliation.');
        }

        case 'pm_limit_sell': {
          const lsConditionId = this.requirePolymarketString(args, 'conditionId', 'pm_limit_sell');
          const lsOutcome = this.normalizePolymarketOutcome(args.outcome, 'pm_limit_sell');
          const lsPrice = this.parsePolymarketPositiveNumber(args.price, 'price', 'pm_limit_sell', { zeroToOneExclusive: true });
          const lsShares = this.parsePolymarketPositiveNumber(args.shares, 'shares', 'pm_limit_sell');
          const lsPostOnly = (args.postOnly as boolean) ?? true;
          const preflight = await this.runPolymarketPreflight({
            action: 'limit_sell',
            conditionId: lsConditionId,
            outcome: lsOutcome,
            price: lsPrice,
            shares: lsShares,
            postOnly: lsPostOnly,
          });
          if (preflight.verdict === 'blocked') {
            const reasons = preflight.checks
              .filter((check: { status: string }) => check.status === 'blocked')
              .map((check: { message: string }) => check.message)
              .join(' ');
            throw new Error(`pm_limit_sell preflight failed: ${reasons}`);
          }
          const lsTokenId = preflight.tokenId as string;

          // Step 2: get authenticated CLOB client (signs EIP-712, calls /auth/derive-api-key)
          let authed: any;
          try {
            authed = await this.getAuthedClobClient();
            if (!authed || typeof authed.createOrder !== 'function' || typeof authed.postOrder !== 'function') {
              throw new Error('getAuthedClobClient returned invalid client');
            }
            // Validate: does the client have credentials?
            if (!authed.creds?.key || !authed.creds?.secret) {
              throw new Error('Authenticated Polymarket CLI adapter is unavailable.');
            }
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            throw new Error(
              `pm_limit_sell [auth setup]: ${msg}. ` +
              `Fix: ensure wallet has a Polymarket CLOB API key at https://clob.polymarket.com/keys`,
            );
          }

          // Step 3: get market info for tick size and neg_risk
          let marketInfo: any;
          try {
            marketInfo = await authed.getMarket(lsConditionId);
            if (!marketInfo) throw new Error('getMarket returned null');
          } catch (err: any) {
            throw new Error(`pm_limit_sell [market info]: ${err?.message ?? String(err)}`);
          }

          // Resolve order parameters with defaults
          const tsRaw = marketInfo?.minimum_tick_size ?? '0.01';
          const tickSize = isNaN(parseFloat(tsRaw)) ? '0.01' : String(parseFloat(tsRaw));
          const negRisk = marketInfo?.neg_risk ?? false;

          // Step 4: place the GTC limit sell order using two-step (createOrder + postOrder).
          // This gives us better error control than createAndPostOrder.
          // deferExec=true: do NOT attempt immediate matching against AMM/CLOB bids
          // postOnly=true: reject if order would cross the spread (takes liquidity)
          let signedOrder: any;
          try {
            signedOrder = await authed.createOrder(
              {
                tokenID: lsTokenId,
                price: lsPrice,
                side: 'sell',
                size: lsShares,
                feeRateBps: 0,
              },
              {
                tickSize,
                negRisk,
              },
            );
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            const respData = err?.response?.data ?? err?.response?._data ?? err?.data;
            const detail = respData ? ` [CLOB: ${JSON.stringify(respData).slice(0, 200)}]` : '';
            throw new Error(`pm_limit_sell [createOrder]: ${msg}${detail}`);
          }

          let orderRes: any;
          try {
            orderRes = await authed.postOrder(
              signedOrder,
              'GTC',
              lsPostOnly, // deferExec: true = post to book only, no AMM match attempt
              lsPostOnly, // postOnlyReject: true = reject if would cross spread
            );
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            const respData = err?.response?.data ?? err?.response?._data ?? err?.data;
            const detail = respData ? ` [CLOB: ${JSON.stringify(respData).slice(0, 200)}]` : '';
            throw new Error(`pm_limit_sell [postOrder]: ${msg}${detail}`);
          }

          // If postOrder returned a failure indicator, surface it as an error
          const orderSuccess = orderRes?.success !== false && orderRes?.status !== 400 && orderRes?.error !== true;
          if (!orderSuccess) {
            const errorMsg =
              orderRes?.error?.message ??
              orderRes?.message ??
              orderRes?.reason ??
              orderRes?.msg ??
              JSON.stringify(orderRes).slice(0, 200);
            throw new Error(
              `pm_limit_sell CLOB rejection: ${errorMsg}. ` +
              `conditionId=${lsConditionId}, tokenId=${lsTokenId.slice(0, 20)}..., ` +
              `price=${lsPrice}, size=${lsShares}, tickSize=${tickSize}. ` +
              `Tip: verify the market tick size (${tickSize}) divides evenly into your price (${lsPrice}).`,
            );
          }

          const submissionFailure = this.getPolymarketSubmissionFailure(orderRes);
          const orderID = this.getPolymarketOrderId(orderRes);
          if (submissionFailure) {
            result = {
              tool: 'pm_limit_sell',
              request: {
                conditionId: lsConditionId,
                outcome: lsOutcome,
                price: lsPrice,
                shares: lsShares,
                postOnly: lsPostOnly,
              },
              preflight,
              submission: {
                orderID,
                status: submissionFailure.status ?? 'rejected',
                tokenId: lsTokenId,
                outcome: lsOutcome,
                price: lsPrice,
                shares: lsShares,
                totalProceeds: lsPrice * lsShares,
                postOnly: lsPostOnly,
                orderType: 'GTC',
                deferExec: lsPostOnly,
                raw: orderRes,
                error: submissionFailure,
              },
              verification: this.buildSkippedPolymarketVerification(submissionFailure, lsTokenId),
              warnings: [...(preflight.warnings ?? []), submissionFailure.message],
              orderID,
              status: submissionFailure.status ?? 'rejected',
              tokenId: lsTokenId,
              outcome: lsOutcome,
              price: lsPrice,
              shares: lsShares,
              totalProceeds: lsPrice * lsShares,
              postOnly: lsPostOnly,
              orderType: 'GTC',
              deferExec: lsPostOnly,
            };
            break;
          }

          const orderStatus = orderRes?.status ?? 'POSTED';
          const verification = await this.reconcilePolymarketVenue({
            orderId: orderID ?? undefined,
            tokenId: lsTokenId,
            conditionId: lsConditionId,
            outcome: lsOutcome,
          });

          result = {
            tool: 'pm_limit_sell',
            request: {
              conditionId: lsConditionId,
              outcome: lsOutcome,
              price: lsPrice,
              shares: lsShares,
              postOnly: lsPostOnly,
            },
            preflight,
            submission: {
              orderID,
              status: orderStatus,
              tokenId: lsTokenId,
              outcome: lsOutcome,
              price: lsPrice,
              shares: lsShares,
              totalProceeds: lsPrice * lsShares,
              postOnly: lsPostOnly,
              orderType: 'GTC',
              deferExec: lsPostOnly,
              raw: orderRes,
            },
            verification,
            warnings: preflight.warnings ?? [],
            orderID,
            status: orderStatus,
            tokenId: lsTokenId,
            outcome: lsOutcome,
            price: lsPrice,
            shares: lsShares,
            totalProceeds: lsPrice * lsShares,
            postOnly: lsPostOnly,
            orderType: 'GTC',
            deferExec: lsPostOnly, // true = post to book only (no AMM hit)
          };
          break;
        }

        case 'pm_reconcile': {
          const walletAddress = typeof args.walletAddress === 'string' && args.walletAddress.trim().length > 0
            ? args.walletAddress.trim()
            : undefined;
          const orderId = typeof args.orderId === 'string' && args.orderId.trim().length > 0
            ? args.orderId.trim()
            : undefined;
          const conditionId = typeof args.conditionId === 'string' && args.conditionId.trim().length > 0
            ? args.conditionId.trim()
            : undefined;
          const tokenId = typeof args.tokenId === 'string' && args.tokenId.trim().length > 0
            ? args.tokenId.trim()
            : undefined;
          const outcome = typeof args.outcome === 'string'
            ? this.normalizePolymarketOutcome(args.outcome, 'pm_reconcile')
            : undefined;
          result = await this.reconcilePolymarketVenue({ walletAddress, orderId, conditionId, outcome, tokenId });
          break;
        }

        case 'pm_redeem': {
          const conditionId = this.requirePolymarketString(args, 'conditionId', 'pm_redeem');
          const redemption = await this.getPolymarket().redeemPositions(conditionId);
          result = {
            tool: 'pm_redeem',
            request: {
              conditionId: redemption.conditionId,
            },
            submission: {
              txHash: redemption.txHash,
              status: redemption.receiptStatus,
              collateralToken: redemption.collateralToken,
              ctfContract: redemption.ctfContract,
              parentCollectionId: redemption.parentCollectionId,
              indexSets: redemption.indexSets,
              tokenIds: redemption.tokenIds,
              marketQuestion: redemption.marketQuestion,
              winningOutcomes: redemption.winningOutcomes,
            },
            verification: {
              blockNumber: redemption.blockNumber,
              payoutVector: redemption.payoutVector,
              usdcBefore: redemption.usdcBefore,
              usdcAfter: redemption.usdcAfter,
              usdcDelta: redemption.usdcDelta,
              tokenBalancesBefore: redemption.tokenBalancesBefore,
              tokenBalancesAfter: redemption.tokenBalancesAfter,
            },
            redeemed: redemption.receiptStatus === 'success',
            txHash: redemption.txHash,
            usdcDelta: redemption.usdcDelta,
            winningOutcomes: redemption.winningOutcomes,
          };
          break;
        }


        // ── Phase 8: A2A Protocol ──

        case 'fetch_agent_card': {
          let card;
          if (args.url) {
            assertSafeUrl(args.url as string, { allowHttp: true, blockPrivateNetwork: true });
            card = await this.a2aClient.fetchAgentCard(args.url as string);
          } else if (args.agentId) {
            card = await this.a2aClient.resolveAgentCardFromERC8004(args.agentId as string);
          } else {
            throw new EvalancheError('Provide either url or agentId', EvalancheErrorCode.A2A_ERROR);
          }
          result = card;
          break;
        }

        case 'a2a_list_skills': {
          let card;
          if (args.url) {
            assertSafeUrl(args.url as string, { allowHttp: true, blockPrivateNetwork: true });
            card = await this.a2aClient.fetchAgentCard(args.url as string);
          } else if (args.agentId) {
            card = await this.a2aClient.resolveAgentCardFromERC8004(args.agentId as string);
          } else {
            throw new EvalancheError('Provide either url or agentId', EvalancheErrorCode.A2A_ERROR);
          }
          const skills = this.a2aClient.listSkills(card);
          result = { agentName: card.name, skills, count: skills.length };
          break;
        }

        case 'a2a_submit_task': {
          const submitUrl = args.url as string;
          assertSafeUrl(submitUrl, { allowHttp: true, blockPrivateNetwork: true });
          // Fetch agent card to derive auth placement if the agent uses non-header auth
          const submitCard = await this.a2aClient.fetchAgentCard(submitUrl);
          const submitAuthPlacement = submitCard.authentication
            ? { in: submitCard.authentication.in, name: submitCard.authentication.name }
            : undefined;
          const task = await this.a2aClient.submitTask(submitUrl, {
            skillId: args.skillId as string,
            input: args.input as string,
            auth: args.auth as string | undefined,
            authPlacement: submitAuthPlacement,
          });
          result = { taskId: task.id, status: task.status };
          break;
        }

        case 'a2a_get_task': {
          const getUrl = args.url as string;
          assertSafeUrl(getUrl, { allowHttp: true, blockPrivateNetwork: true });
          const getCard = await this.a2aClient.fetchAgentCard(getUrl);
          const getAuthPlacement = getCard.authentication
            ? { in: getCard.authentication.in, name: getCard.authentication.name }
            : undefined;
          const task = await this.a2aClient.getTask(
            getUrl,
            args.taskId as string,
            args.auth as string | undefined,
            getAuthPlacement,
          );
          result = {
            taskId: task.id,
            status: task.status,
            messages: task.messages,
            artifacts: task.artifacts,
            error: task.error,
          };
          break;
        }

        case 'a2a_cancel_task': {
          const cancelUrl = args.url as string;
          assertSafeUrl(cancelUrl, { allowHttp: true, blockPrivateNetwork: true });
          const cancelCard = await this.a2aClient.fetchAgentCard(cancelUrl);
          const cancelAuthPlacement = cancelCard.authentication
            ? { in: cancelCard.authentication.in, name: cancelCard.authentication.name }
            : undefined;
          const task = await this.a2aClient.cancelTask(
            cancelUrl,
            args.taskId as string,
            args.auth as string | undefined,
            cancelAuthPlacement,
          );
          result = { taskId: task.id, status: task.status };
          break;
        }

        case 'a2a_serve': {
          if (!this.a2aServer) {
            this.a2aServer = new A2AServer({
              name: 'evalanche-agent',
              url: `http://localhost:3100`,
              description: 'Evalanche A2A agent',
            });
            await this.a2aServer.listen(3100);
          }

          // Bind to a real Evalanche capability instead of a stub
          const capability = (args.capability as string) ?? undefined;
          const skillHandler = this.buildA2ASkillHandler(capability);

          const skillId = this.a2aServer.registerSkill({
            id: args.skillId as string | undefined,
            name: args.name as string,
            description: args.description as string,
            tags: args.tags as string[] | undefined,
            handler: skillHandler,
          });
          const card = this.a2aServer.getAgentCard();
          result = {
            skillId,
            capability: capability ?? 'echo (no capability specified)',
            agentCard: card,
            message: `Skill registered. Agent card at http://localhost:3100/.well-known/agent-card.json`,
          };
          break;
        }

        default:
          return this.error(id, -32602, `Unknown tool: ${name}`);
      }

      return this.ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.ok(id, {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  /** Start the MCP server in stdio mode (JSON-RPC over stdin/stdout) */
  startStdio(): void {
    let buffer = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', async (chunk: string) => {
      buffer += chunk;

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const request = JSON.parse(trimmed) as MCPRequest;
          const response = await this.handleRequest(request);

          if (request.method.startsWith('notifications/')) continue;
          process.stdout.write(JSON.stringify(response) + '\n');
        } catch {
          const errResponse: MCPResponse = {
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32700, message: 'Parse error' },
          };
          process.stdout.write(JSON.stringify(errResponse) + '\n');
        }
      }
    });

    process.stderr.write('Evalanche MCP server started (stdio)\n');
  }

  /** Start the MCP server in HTTP mode */
  startHTTP(options: number | MCPHTTPOptions = DEFAULT_HTTP_PORT): Server {
    const config = typeof options === 'number' ? { port: options } : options;
    const port = config.port ?? DEFAULT_HTTP_PORT;
    const host = config.host ?? DEFAULT_HTTP_HOST;
    const authToken = config.authToken ?? process.env.EVALANCHE_MCP_HTTP_TOKEN;
    const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;

    if (!authToken) {
      throw new EvalancheError(
        'HTTP MCP transport requires EVALANCHE_MCP_HTTP_TOKEN or startHTTP({ authToken })',
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      if (!this.isAuthorizedHTTP(req, authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32001, message: 'Unauthorized' },
        }));
        return;
      }

      req.setTimeout(10_000, () => {
        res.writeHead(408);
        res.end('Request timeout');
        req.destroy();
      });

      let body = '';
      let receivedBytes = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maxBodyBytes) {
          rejected = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32002, message: 'Request body too large' },
          }));
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on('end', async () => {
        if (rejected) return;
        try {
          const request = JSON.parse(body) as MCPRequest;
          const response = await this.handleRequest(request);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            error: { code: -32700, message: 'Parse error' },
          }));
        }
      });
    });

    server.listen(port, host, () => {
      process.stderr.write(`Evalanche MCP server started on http://${host}:${port}\n`);
    });

    return server;
  }

  private ok(id: string | number, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
