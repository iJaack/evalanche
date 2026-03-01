import { Evalanche } from '../agent';
import type { EvalancheConfig } from '../agent';
import { IdentityResolver } from '../identity/resolver';
import { EvalancheError } from '../utils/errors';
import { getNetworkConfig } from '../utils/networks';
import { getAllChains } from '../utils/chains';
import { NATIVE_TOKEN } from '../bridge/lifi';
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
];

/**
 * Evalanche MCP Server — exposes agent wallet capabilities as MCP tools.
 *
 * Supports both stdio (JSON-RPC over stdin/stdout) and HTTP transport.
 */
export class EvalancheMCPServer {
  private agent: Evalanche;
  private config: EvalancheConfig;

  constructor(config: EvalancheConfig) {
    this.config = config;
    this.agent = new Evalanche(config);
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
              version: '0.4.0',
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
