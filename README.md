# 🏔️ Evalanche

**Agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402)**

Evalanche gives AI agents a programmatic wallet on Avalanche with built-in onchain identity and payment capabilities — no browser, no popups, no human in the loop.

## Background

Evalanche's architecture is informed by [Ava Labs' Core Extension](https://github.com/ava-labs/core-extension) wallet — specifically its service-worker signing patterns, network management, and multi-secret-type design (mnemonic, Ledger, Fireblocks, seedless). We studied Core Extension's `WalletService`, `AccountsService`, and `NetworkService` to understand how Core handles transaction signing and account derivation, then rebuilt these patterns as a headless SDK optimized for agent use cases.

**v0.1.0** focuses on C-Chain (EVM) via ethers v6. The [roadmap](#roadmap) includes integrating `@avalabs/avalanchejs` and `@avalabs/core-wallets-sdk` for native X-Chain/P-Chain support (AVAX transfers, staking, cross-chain operations) — bringing the full Core Wallet infrastructure into the headless agent context.

A companion [Core Extension PR](https://github.com/iJaack/core-extension/tree/feat/erc8004-agent-identity) adds ERC-8004 agent identity resolution directly into the Core wallet approval UI, so humans can see an agent's on-chain reputation when approving transactions.

## Install

```bash
npm install evalanche
```

## Quick Start

```typescript
import { Evalanche } from 'evalanche';

const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche', // 'avalanche' | 'fuji' | { rpcUrl, chainId }
  identity: {
    agentId: '1599',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
});

// Send AVAX
const tx = await agent.send({
  to: '0x...',
  value: '0.1', // human-readable AVAX
});

// Sign messages
const signature = await agent.signMessage('Hello from my agent');
```

## API Reference

### `new Evalanche(config)`

Create a new agent instance.

| Option | Type | Description |
|--------|------|-------------|
| `privateKey` | `string` | Hex-encoded private key |
| `mnemonic` | `string` | BIP-39 mnemonic phrase |
| `network` | `'avalanche' \| 'fuji' \| { rpcUrl, chainId }` | Network to connect to (default: `'avalanche'`) |
| `identity` | `{ agentId, registry? }` | Optional ERC-8004 identity config |

### `agent.address`

The agent's wallet address.

### `agent.resolveIdentity(): Promise<AgentIdentity>`

Resolve the agent's on-chain ERC-8004 identity, including reputation score and trust level.

### `agent.send(intent): Promise<TransactionResult>`

Send a value transfer or raw data transaction.

```typescript
await agent.send({ to: '0x...', value: '0.1' });
```

### `agent.call(intent): Promise<TransactionResult>`

Call a contract method (state-changing).

```typescript
await agent.call({
  contract: '0x...',
  abi: ['function transfer(address to, uint256 amount)'],
  method: 'transfer',
  args: ['0x...', '1000000'],
});
```

### `agent.payAndFetch(url, options): Promise<PayAndFetchResult>`

Make an x402 payment-gated HTTP request. Automatically handles the 402 flow.

```typescript
const response = await agent.payAndFetch('https://api.example.com/data', {
  maxPayment: '0.01',
});
```

### `agent.submitFeedback(feedback): Promise<string>`

Submit reputation feedback for another agent on-chain.

```typescript
await agent.submitFeedback({
  targetAgentId: '42',
  taskRef: 'task-001',
  score: 85,
  metadata: { verified: true },
});
```

### `agent.signMessage(message): Promise<string>`

Sign an arbitrary message with the agent's wallet key.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Evalanche                   │
│                                             │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │  Wallet   │ │ Identity │ │ Reputation │  │
│  │  Signer   │ │ Resolver │ │  Reporter  │  │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘  │
│       │             │             │          │
│  ┌────┴─────┐ ┌────┴─────┐       │          │
│  │   Tx     │ │ ERC-8004 │       │          │
│  │ Builder  │ │ Registry │       │          │
│  └────┬─────┘ └──────────┘       │          │
│       │                           │          │
│  ┌────┴──────────────────────────┴──────┐   │
│  │            x402 Client               │   │
│  │  (Pay-gated HTTP + Facilitator)      │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  ┌──────────────────────────────────────┐   │
│  │   Avalanche C-Chain / Fuji Testnet   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## ERC-8004 Integration

Evalanche integrates with the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) standard for on-chain agent identity. When you provide an `identity` config, the SDK can:

- Resolve your agent's `tokenURI` and metadata from the identity registry
- Query on-chain reputation scores (0-100)
- Derive trust levels: **high** (>=75), **medium** (>=40), **low** (<40)
- Cache results with a 5-minute TTL

## x402 Integration

The x402 payment protocol enables pay-per-request API access. `payAndFetch` handles the full flow:

1. Makes the initial HTTP request
2. If 402 Payment Required, parses payment requirements from headers
3. Validates the payment amount against your `maxPayment` limit
4. Creates a signed payment proof
5. Retries the request with the payment proof

## MCP Server

Evalanche includes an MCP (Model Context Protocol) server, so AI agent frameworks can use it as a tool provider.

### Stdio mode (default — for Claude Desktop, Cursor, etc.)

```bash
AGENT_PRIVATE_KEY=0x... evalanche-mcp
```

### HTTP mode

```bash
AGENT_PRIVATE_KEY=0x... evalanche-mcp --http --port 3402
```

### Claude Desktop config (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "evalanche": {
      "command": "npx",
      "args": ["evalanche-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_ID": "1599",
        "AVALANCHE_NETWORK": "avalanche"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_PRIVATE_KEY` | Yes* | Agent wallet private key |
| `AGENT_MNEMONIC` | Yes* | BIP-39 mnemonic (alternative) |
| `AGENT_ID` | No | ERC-8004 agent ID (enables identity resolution) |
| `AGENT_REGISTRY` | No | Custom ERC-8004 registry address |
| `AVALANCHE_NETWORK` | No | `avalanche` (default) or `fuji` |
| `AVALANCHE_RPC_URL` | No | Custom RPC URL |

\* One of `AGENT_PRIVATE_KEY` or `AGENT_MNEMONIC` is required.

### Available MCP tools

| Tool | Description |
|------|-------------|
| `get_address` | Get agent wallet address |
| `get_balance` | Get AVAX balance |
| `resolve_identity` | Resolve this agent's ERC-8004 identity |
| `resolve_agent` | Resolve any agent's ERC-8004 identity by ID |
| `send_avax` | Send AVAX to an address |
| `call_contract` | Call a contract method |
| `sign_message` | Sign a message |
| `pay_and_fetch` | x402 payment-gated HTTP request |
| `submit_feedback` | Submit on-chain reputation feedback |
| `get_network` | Get current network config |

### Programmatic usage

```typescript
import { EvalancheMCPServer } from 'evalanche';

const server = new EvalancheMCPServer({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche',
  identity: { agentId: '1599' },
});

// Stdio (standard MCP transport)
server.startStdio();

// Or HTTP
server.startHTTP(3402);
```

## Roadmap

### v0.1.0 (current)
- ✅ C-Chain wallet (ethers v6) — send AVAX, call contracts, sign messages
- ✅ ERC-8004 identity resolution — agent ID, reputation, trust levels
- ✅ x402 payment-gated HTTP client — full 402 flow
- ✅ On-chain reputation feedback submission
- ✅ MCP server (stdio + HTTP) — 10 tools for AI frameworks

### v0.2.0 (planned)
- [ ] Integrate `@avalabs/avalanchejs` for native X-Chain and P-Chain support
- [ ] Integrate `@avalabs/core-wallets-sdk` for Core-compatible account derivation
- [ ] Cross-chain transfers (C→X, C→P, X→C)
- [ ] P-Chain staking operations (delegate, validate)
- [ ] Multi-VM transaction signing (EVM + AVM + PVM)

### v0.3.0 (planned)
- [ ] Subnet/L1 support — custom network configs with VM-specific signing
- [ ] ICM (Interchain Messaging) integration
- [ ] Agent-to-agent payment channels
- [ ] Ledger/hardware wallet support (for human-supervised agent operations)

## License

MIT
