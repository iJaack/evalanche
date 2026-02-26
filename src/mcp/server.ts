import { Evalanche } from '../agent';
import type { EvalancheConfig } from '../agent';
import { IdentityResolver } from '../identity/resolver';
import { EvalancheError } from '../utils/errors';
import { NETWORKS } from '../utils/networks';
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
    description: 'Get the AVAX balance of the agent wallet (or any address)',
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
    description: 'Send AVAX to an address. Value is in human-readable AVAX (e.g. "0.1").',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination address' },
        value: { type: 'string', description: 'Amount in AVAX (e.g. "0.1")' },
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
        value: { type: 'string', description: 'AVAX to send with call (optional)' },
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
        maxPayment: { type: 'string', description: 'Maximum AVAX willing to pay (e.g. "0.01")' },
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
              version: '0.1.0',
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
          result = { address: addr, balance: formatEther(balance), unit: 'AVAX' };
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
          const networkConfig = typeof this.config.network === 'string'
            ? NETWORKS[this.config.network ?? 'avalanche']
            : this.config.network;
          result = { network: networkName, ...networkConfig };
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
