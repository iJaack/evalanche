# Evalanche

**Multi-EVM agent wallet SDK with onchain identity (ERC-8004), payment rails (x402), and cross-chain bridging (Li.Fi + Gas.zip)**

Evalanche gives AI agents a **non-custodial** wallet on **any EVM chain** — Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, and 15+ more — with built-in onchain identity, payment capabilities, and cross-chain bridging. No browser, no popups, no human in the loop.

## Install

```bash
npm install evalanche
```

## Quick Start

### On any EVM chain

```typescript
import { Evalanche } from 'evalanche';

// Boot on Base
const { agent } = await Evalanche.boot({ network: 'base' });

// Boot on Ethereum
const { agent: ethAgent } = await Evalanche.boot({ network: 'ethereum' });

// Boot on Arbitrum
const { agent: arbAgent } = await Evalanche.boot({ network: 'arbitrum' });

// Boot on Avalanche (with identity)
const { agent: avaxAgent } = await Evalanche.boot({
  network: 'avalanche',
  identity: { agentId: '1599' },
});
```

### Non-custodial (recommended)

```typescript
// First run: generates wallet, encrypts to ~/.evalanche/keys/agent.json
// Every subsequent run: decrypts and loads the same wallet
const { agent, keystore } = await Evalanche.boot({ network: 'base' });

console.log(agent.address);         // 0x... (same every time)
console.log(keystore.isNew);        // true first run, false after

// Send tokens
await agent.send({ to: '0x...', value: '0.1' });

// Bridge tokens cross-chain
await agent.bridgeTokens({
  fromChainId: 8453,    // Base
  toChainId: 42161,     // Arbitrum
  fromToken: 'native',
  toToken: 'native',
  fromAmount: '0.1',
  fromAddress: agent.address,
});
```

### One-shot generation

```typescript
const { agent, wallet } = Evalanche.generate({ network: 'optimism' });
console.log(wallet.mnemonic);   // 12-word BIP-39
console.log(wallet.address);    // 0x...
```

### Existing keys

```typescript
const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'polygon',
});
```

## Supported Networks

| Network | Chain ID | Alias | RPC Source | Explorer |
|---------|----------|-------|------------|----------|
| Ethereum | 1 | `ethereum` | Public | etherscan.io |
| Base | 8453 | `base` | Routescan | basescan.org |
| Arbitrum One | 42161 | `arbitrum` | Routescan | arbiscan.io |
| Optimism | 10 | `optimism` | Routescan | optimistic.etherscan.io |
| Polygon | 137 | `polygon` | Routescan | polygonscan.com |
| BNB Smart Chain | 56 | `bsc` | Routescan | bscscan.com |
| Avalanche C-Chain | 43114 | `avalanche` | Routescan | snowtrace.io |
| Fantom | 250 | `fantom` | Routescan | ftmscan.com |
| Gnosis | 100 | `gnosis` | Public | gnosisscan.io |
| zkSync Era | 324 | `zksync` | Public | explorer.zksync.io |
| Linea | 59144 | `linea` | Public | lineascan.build |
| Scroll | 534352 | `scroll` | Public | scrollscan.com |
| Blast | 81457 | `blast` | Public | blastscan.io |
| Mantle | 5000 | `mantle` | Public | explorer.mantle.xyz |
| Celo | 42220 | `celo` | Public | celoscan.io |
| Moonbeam | 1284 | `moonbeam` | Public | moonscan.io |
| Cronos | 25 | `cronos` | Routescan | cronoscan.com |
| Berachain | 80094 | `berachain` | Routescan | berascan.com |
| Avalanche Fuji | 43113 | `fuji` | Routescan | testnet.snowtrace.io |
| Sepolia | 11155111 | `sepolia` | Public | sepolia.etherscan.io |
| Base Sepolia | 84532 | `base-sepolia` | Public | sepolia.basescan.org |

Routescan RPCs are used as the primary RPC where available, with public fallback RPCs.

## Cross-Chain Bridging

### Li.Fi — Token Bridging

Bridge tokens between any supported chains using Li.Fi's aggregated bridge/DEX routes.

```typescript
const agent = new Evalanche({ privateKey: '0x...', network: 'ethereum' });

// Get a bridge quote
const quote = await agent.getBridgeQuote({
  fromChainId: 1,       // Ethereum
  toChainId: 8453,      // Base
  fromToken: '0x0000000000000000000000000000000000000000', // Native ETH
  toToken: '0x0000000000000000000000000000000000000000',   // Native ETH
  fromAmount: '0.1',
  fromAddress: agent.address,
});

console.log(quote.toAmount);       // Expected output
console.log(quote.estimatedTime);  // Seconds
console.log(quote.tool);           // e.g. 'across', 'stargate'

// Execute the bridge
const result = await agent.bridgeTokens({
  fromChainId: 1,
  toChainId: 8453,
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0x0000000000000000000000000000000000000000',
  fromAmount: '0.1',
  fromAddress: agent.address,
});
console.log(result.txHash);

// Get multiple route options
const routes = await agent.getBridgeRoutes({ /* same params */ });
```

### Gas.zip — Destination Gas Funding

Fund gas on a destination chain cheaply via Gas.zip.

```typescript
// Send gas from Ethereum to Arbitrum
await agent.fundDestinationGas({
  fromChainId: 1,
  toChainId: 42161,
  toAddress: agent.address,
  destinationGasAmount: '0.01',
});
```

### Network Switching

```typescript
const agent = new Evalanche({ privateKey: '0x...', network: 'ethereum' });

// Switch to Base (returns new instance, same keys)
const baseAgent = agent.switchNetwork('base');
console.log(baseAgent.getChainInfo().name); // "Base"

// List all supported chains
const chains = Evalanche.getSupportedChains();
```

## API Reference

### `Evalanche.boot(options?): Promise<{ agent, keystore, secretsSource }>`

Non-custodial autonomous boot. Generates or loads an encrypted keystore.

| Option | Type | Description |
|--------|------|-------------|
| `network` | `ChainName \| { rpcUrl, chainId }` | Network (default: `'avalanche'`) |
| `identity` | `{ agentId, registry? }` | Optional ERC-8004 identity config |
| `multiVM` | `boolean` | Enable X/P-Chain (Avalanche only) |
| `rpcOverride` | `string` | Override the default RPC URL |
| `keystore.dir` | `string` | Keystore directory (default: `~/.evalanche/keys`) |

### `new Evalanche(config)`

Create an agent with existing keys.

| Option | Type | Description |
|--------|------|-------------|
| `privateKey` | `string` | Hex-encoded private key |
| `mnemonic` | `string` | BIP-39 mnemonic phrase |
| `network` | `ChainName \| { rpcUrl, chainId }` | Any EVM chain (default: `'avalanche'`) |
| `identity` | `{ agentId, registry? }` | Optional ERC-8004 identity config |
| `multiVM` | `boolean` | Enable X/P-Chain (Avalanche only) |
| `rpcOverride` | `string` | Override the default RPC URL |

### Core Methods

| Method | Description |
|--------|-------------|
| `agent.send(intent)` | Send value transfer |
| `agent.call(intent)` | Call contract method |
| `agent.signMessage(message)` | Sign arbitrary message |
| `agent.resolveIdentity()` | Resolve ERC-8004 identity (Avalanche) |
| `agent.payAndFetch(url, options)` | x402 payment-gated HTTP |
| `agent.submitFeedback(feedback)` | Submit reputation feedback |

### Bridge Methods (v0.4.0)

| Method | Description |
|--------|-------------|
| `agent.getBridgeQuote(params)` | Get a bridge quote via Li.Fi |
| `agent.getBridgeRoutes(params)` | Get multiple bridge routes |
| `agent.bridgeTokens(params)` | Bridge tokens (quote + execute) |
| `agent.fundDestinationGas(params)` | Fund gas via Gas.zip |
| `agent.switchNetwork(network)` | Switch to different chain |
| `agent.getChainInfo()` | Get current chain info |
| `Evalanche.getSupportedChains()` | List all supported chains |

### Avalanche Multi-VM (X-Chain, P-Chain)

Multi-VM support requires a **mnemonic** and only works on Avalanche networks.

```typescript
const agent = new Evalanche({
  mnemonic: process.env.AGENT_MNEMONIC,
  network: 'avalanche',
  multiVM: true,
});

const balances = await agent.getMultiChainBalance();
const result = await agent.transfer({ from: 'C', to: 'P', amount: '25' });
await agent.delegate('NodeID-...', '25', 30);
```

> Avalanche dependencies (`@avalabs/core-wallets-sdk`) are lazy-loaded on first multi-VM call.

## ERC-8004 Integration

On-chain agent identity on Avalanche C-Chain. Requires `identity` config:

- Resolve agent `tokenURI` and metadata
- Query reputation scores (0-100)
- Trust levels: **high** (>=75), **medium** (>=40), **low** (<40)

> **Note:** ERC-8004 identity features only work on Avalanche C-Chain (chain ID 43114).

## MCP Server

Evalanche includes an MCP server for AI agent frameworks.

### Setup

```bash
# Stdio mode (Claude Desktop, Cursor, etc.)
AGENT_PRIVATE_KEY=0x... evalanche-mcp

# HTTP mode
AGENT_PRIVATE_KEY=0x... evalanche-mcp --http --port 3402
```

### Claude Desktop config

```json
{
  "mcpServers": {
    "evalanche": {
      "command": "npx",
      "args": ["evalanche-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AVALANCHE_NETWORK": "base"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_address` | Get agent wallet address |
| `get_balance` | Get native token balance |
| `send_avax` | Send native tokens |
| `call_contract` | Call a contract method |
| `sign_message` | Sign a message |
| `resolve_identity` | Resolve ERC-8004 identity |
| `resolve_agent` | Look up any agent by ID |
| `pay_and_fetch` | x402 payment-gated HTTP |
| `submit_feedback` | Submit reputation feedback |
| `get_network` | Get current network config |
| `get_supported_chains` | List all supported chains |
| `get_chain_info` | Get chain details |
| `get_bridge_quote` | Get bridge quote |
| `get_bridge_routes` | Get all bridge routes |
| `bridge_tokens` | Bridge tokens cross-chain |
| `fund_destination_gas` | Fund gas via Gas.zip |
| `switch_network` | Switch EVM network |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_PRIVATE_KEY` | Agent wallet private key |
| `AGENT_MNEMONIC` | BIP-39 mnemonic (alternative) |
| `AGENT_KEYSTORE_DIR` | Keystore directory for `boot()` mode |
| `AGENT_ID` | ERC-8004 agent ID |
| `AVALANCHE_NETWORK` | Network alias (e.g. `base`, `ethereum`, `avalanche`) |
| `AVALANCHE_RPC_URL` | Custom RPC URL override |

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   Evalanche                       │
│                                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐       │
│  │ Keystore │ │ Identity │ │ Reputation │       │
│  │(AES+scry)│ │ Resolver │ │  Reporter  │       │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘       │
│       │             │             │               │
│  ┌────┴─────┐ ┌────┴─────┐       │               │
│  │  Wallet  │ │ ERC-8004 │       │               │
│  │  Signer  │ │ Registry │       │               │
│  └────┬─────┘ └──────────┘       │               │
│       │                           │               │
│  ┌────┴─────┐ ┌──────────────────┴─────────────┐│
│  │   Tx     │ │     x402 Client                ││
│  │ Builder  │ │ (Pay-gated HTTP + Facilitator) ││
│  └────┬─────┘ └────────────────────────────────┘│
│       │                                          │
│  ┌────┴──────────────────────────────────────┐  │
│  │  Bridge Client (Li.Fi + Gas.zip)          │  │
│  │  Cross-chain swaps & gas funding          │  │
│  └────┬──────────────────────────────────────┘  │
│       │                                          │
│  ┌────┴──────────────────────────────────────┐  │
│  │  Chain Registry (21+ EVM chains)          │  │
│  │  Routescan RPCs │ Public fallbacks        │  │
│  └────┬──────────────────────────────────────┘  │
│       │                                          │
│  ┌────┴──────────────────────────────────────┐  │
│  │  EVM (ethers v6) │ X-Chain │ P-Chain      │  │
│  │  Any EVM chain   │ Avalanche-only         │  │
│  └───────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Roadmap

### v0.1.0
- C-Chain wallet, ERC-8004 identity, x402 payments, MCP server

### v0.2.0
- Multi-VM: X-Chain, P-Chain, cross-chain transfers, staking

### v0.3.0
- Non-custodial keystore, `Evalanche.boot()`, OpenClaw secrets

### v0.4.0 (current)
- Multi-EVM support (21+ chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, etc.)
- Routescan RPCs as preferred provider
- Li.Fi cross-chain bridging
- Gas.zip destination gas funding
- Network switching
- 17 MCP tools (7 new)

### v0.5.0 (planned)
- Subnet/L1 support
- ICM (Interchain Messaging) integration
- Agent-to-agent payment channels

## License

MIT
