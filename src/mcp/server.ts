import { Evalanche } from '../agent';
import type { EvalancheConfig } from '../agent';
import { IdentityResolver } from '../identity/resolver';
import { ArenaSwapClient } from '../swap/arena';
import { approveAndCall, upgradeProxy } from '../utils/contract-helpers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { getNetworkConfig } from '../utils/networks';
import { getAllChains } from '../utils/chains';
import { NATIVE_TOKEN } from '../bridge/lifi';
import { DiscoveryClient } from '../economy/discovery';
import { AgentServiceHost } from '../economy/service';
import { NegotiationClient } from '../economy/negotiation';
import { SettlementClient } from '../economy/settlement';
import { AgentMemory } from '../economy/memory';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

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
        network: { type: 'string', description: 'Network name (e.g. "ethereum", "base", "arbitrum", "optimism", "polygon")' },
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
    description: 'Set or update the agent spending policy. Controls per-transaction limits, hourly/daily budgets, contract allowlists, and chain restrictions. Pass an empty object to remove the policy.',
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

  constructor(config: EvalancheConfig) {
    this.config = config;
    this.agent = new Evalanche(config);
    this.discovery = new DiscoveryClient(this.agent.provider);
    this.serviceHost = new AgentServiceHost(this.agent.address);
    this.negotiation = new NegotiationClient();
    this.settlement = new SettlementClient(this.agent.wallet, this.negotiation);
    this.memory = new AgentMemory(); // in-memory by default; can be swapped for file-backed
  }

  /** Handle a JSON-RPC request and return a response */
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
              version: '0.9.0',
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
          this.config = { ...this.config, network: networkName as EvalancheConfig['network'] & string };
          this.agent = new Evalanche(this.config);
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
          const approveCallResult = await approveAndCall(
            this.agent.wallet,
            args.tokenAddress as string,
            args.spenderAddress as string,
            BigInt(args.amount as string),
            {
              to: (args.targetAddress as string | undefined) ?? (args.spenderAddress as string),
              data: args.contractCallData as string,
              value: args.valueWei ? BigInt(args.valueWei as string) : undefined,
              gasLimit: args.gasLimit ? BigInt(args.gasLimit as string) : undefined,
            },
          );
          result = approveCallResult;
          break;
        }

        case 'upgrade_proxy': {
          const upgradeResult = await upgradeProxy(
            this.agent.wallet,
            args.proxyAddress as string,
            args.newImplementationAddress as string,
            args.initData as string | undefined,
          );
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
          result = await this.agent.swap({
            fromChainId: chainId,
            toChainId: chainId,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
          });
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
          const txResult = await this.agent.bridgeTokens({
            fromChainId: args.fromChainId as number,
            toChainId: args.toChainId as number,
            fromToken: this.normalizeToken(args.fromToken as string),
            toToken: this.normalizeToken(args.toVaultToken as string),
            fromAmount: args.fromAmount as string,
            fromAddress: this.agent.address,
            slippage: args.slippage as number | undefined,
          });
          result = txResult;
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
          // If no meaningful fields are passed, remove the policy
          const hasFields = Object.keys(args).length > 0;
          if (hasFields) {
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
          } else {
            this.agent.setPolicy(null);
            result = { success: true, message: 'Policy removed' };
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

      // Process complete JSON-RPC messages (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const request = JSON.parse(trimmed) as MCPRequest;
          const response = await this.handleRequest(request);

          // Notifications don't get responses
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
  startHTTP(port: number = 3402): void {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
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

    server.listen(port, () => {
      process.stderr.write(`Evalanche MCP server started on http://localhost:${port}\n`);
    });
  }

  private ok(id: string | number, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: string | number, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
