# Evalanche

**Multi-EVM agent wallet SDK with onchain identity (ERC-8004), full agent identity resolution, payment rails (x402), cross-chain liquidity (Li.Fi bridging + DEX aggregation + DeFi Composer), gas funding (Gas.zip), agent economy layer, and perpetual futures (dYdX v4)**

Evalanche gives AI agents a **non-custodial** wallet on **any EVM chain** — Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, and 15+ more — with built-in onchain identity, ERC-8004 full registration resolution, payment capabilities, cross-chain bridging, same-chain DEX swaps (31+ aggregators), agent economy primitives (discovery, negotiation, settlement, escrow, memory), and one-click DeFi operations. No browser, no popups, no human in the loop.

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

### Li.Fi — Cross-Chain Liquidity (v0.8.0)

Full Li.Fi integration: bridging, same-chain DEX aggregation, DeFi Composer, token/chain discovery, gas pricing, and transfer status tracking.

```typescript
const agent = new Evalanche({ privateKey: '0x...', network: 'ethereum' });

// Bridge tokens cross-chain
const result = await agent.bridgeTokens({
  fromChainId: 1,       // Ethereum
  toChainId: 8453,      // Base
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0x0000000000000000000000000000000000000000',
  fromAmount: '0.1',
  fromAddress: agent.address,
});

// Track transfer status (poll until DONE or FAILED)
const status = await agent.checkBridgeStatus({
  txHash: result.txHash,
  fromChainId: 1,
  toChainId: 8453,
});
// → { status: 'DONE', substatus: 'COMPLETED', receiving: { txHash, amount, token, chainId } }

// Same-chain DEX swap (31+ DEX aggregators on any chain)
const swapResult = await agent.swap({
  fromChainId: 8453,    // Base
  toChainId: 8453,      // Same chain = DEX swap
  fromToken: '0x0000000000000000000000000000000000000000', // ETH
  toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  fromAmount: '0.05',
  fromAddress: agent.address,
});

// Token discovery — prices, decimals, symbols
const tokens = await agent.getTokens([8453, 42161]); // Base + Arbitrum tokens
const usdc = await agent.getToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
// → { symbol: 'USDC', decimals: 6, priceUSD: '1.00', ... }

// Chain and tool discovery
const chains = await agent.getLiFiChains(['EVM']);
const tools = await agent.getLiFiTools();
// → { bridges: ['across', 'stargate', ...], exchanges: ['1inch', 'paraswap', ...] }

// Gas prices across chains
const gas = await agent.getGasSuggestion(8453); // Base gas
// → { standard: '0.001', fast: '0.002', slow: '0.0005' }

// Connection discovery — what transfer paths exist
const connections = await agent.getLiFiConnections({
  fromChainId: 1,
  toChainId: 8453,
});

// Get multiple route options
const routes = await agent.getBridgeRoutes({
  fromChainId: 1, toChainId: 8453,
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0x0000000000000000000000000000000000000000',
  fromAmount: '0.1', fromAddress: agent.address,
});
```

#### DeFi Composer (Zaps)

One-transaction cross-chain DeFi operations. Bridge + deposit into a vault/staking/lending protocol in a single tx.

```typescript
// Bridge ETH from Ethereum → deposit into Morpho vault on Base
// Just set toToken to the vault token address!
const composerResult = await agent.bridgeTokens({
  fromChainId: 1,       // Ethereum
  toChainId: 8453,      // Base
  fromToken: '0x0000000000000000000000000000000000000000', // ETH
  toToken: '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A',  // Morpho vault token
  fromAmount: '0.1',
  fromAddress: agent.address,
});

// Supported protocols: Morpho, Aave V3, Euler, Pendle, Lido wstETH,
// EtherFi, Ethena, Maple, Seamless, Felix, HyperLend, and more.
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

### Bridge & Cross-Chain (v0.4.0+)

| Method | Description |
|--------|-------------|
| `agent.getBridgeQuote(params)` | Get a bridge quote via Li.Fi |
| `agent.getBridgeRoutes(params)` | Get multiple bridge routes |
| `agent.bridgeTokens(params)` | Bridge tokens (quote + execute) |
| `agent.fundDestinationGas(params)` | Fund gas via Gas.zip |
| `agent.switchNetwork(network)` | Switch to different chain |
| `agent.getChainInfo()` | Get current chain info |
| `Evalanche.getSupportedChains()` | List all supported chains |

### Li.Fi Liquidity SDK (v0.8.0)

| Method | Description |
|--------|-------------|
| `agent.checkBridgeStatus(params)` | Poll cross-chain transfer status (PENDING/DONE/FAILED) |
| `agent.getSwapQuote(params)` | Get same-chain DEX swap quote |
| `agent.swap(params)` | Execute same-chain DEX swap (31+ aggregators) |
| `agent.getTokens(chainIds)` | List tokens with prices on specified chains |
| `agent.getToken(chainId, address)` | Get specific token info (symbol, decimals, price) |
| `agent.getLiFiChains(chainTypes?)` | List all Li.Fi supported chains |
| `agent.getLiFiTools()` | List available bridges and DEX aggregators |
| `agent.getGasPrices()` | Get gas prices across all chains |
| `agent.getGasSuggestion(chainId)` | Get gas price suggestion for a chain |
| `agent.getLiFiConnections(params)` | Discover possible transfer paths between chains |

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

### dYdX v4 Perpetuals (v0.7.0)

```typescript
const agent = new Evalanche({ mnemonic: '...', network: 'avalanche' });

// Check if a market exists across all venues
const match = await agent.findPerpMarket('AKT-USD');
// → { venue: 'dydx', market: { ticker: 'AKT-USD', oraclePrice: '0.39', maxLeverage: 10, ... } }

// Get dYdX client directly
const dydx = await agent.dydx();

// List markets
const markets = await dydx.getMarkets();

// Place a market order
const orderId = await dydx.placeMarketOrder({
  market: 'AKT-USD',
  side: 'BUY',
  size: '100',
});

// Check positions
const positions = await dydx.getPositions();

// Close a position
await dydx.closePosition('AKT-USD');

// Check balance
const balance = await dydx.getBalance(); // USDC equity
```

> **Note:** dYdX requires a mnemonic (not just a private key) because it derives Cosmos keys from BIP-39.

### Platform CLI — Advanced P-Chain Ops (v0.6.0)

For subnet management, L1 validators, and BLS staking, Evalanche wraps [ava-labs/platform-cli](https://github.com/ava-labs/platform-cli) as an optional subprocess.

**Install the CLI:**
```bash
go install github.com/ava-labs/platform-cli@latest
```

**Usage:**
```typescript
const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche',
});

// Get the platform CLI (auto-detects binary)
const cli = await agent.platformCLI();

// Check availability
const available = await cli.isAvailable(); // true if binary found

// Create a subnet
const subnet = await cli.createSubnet();

// Add a validator with BLS keys
await cli.addValidator({
  nodeId: 'NodeID-...',
  stakeAvax: 2000,
  blsPublicKey: '0x...',
  blsPop: '0x...',
});

// Convert subnet to L1
await cli.convertSubnetToL1({
  subnetId: subnet.subnetId,
  chainId: 'chain-id',
  validators: 'https://node1:9650,https://node2:9650',
});

// Get node info (NodeID + BLS keys)
const info = await cli.getNodeInfo('127.0.0.1:9650');
```

> The platform-cli binary is optional. All existing P-Chain functionality via AvalancheJS continues to work without it. The CLI adds subnet/L1/BLS capabilities that AvalancheJS doesn't support.

## ERC-8004 Integration

On-chain agent identity on Avalanche C-Chain. Requires `identity` config:

- Resolve agent `tokenURI` and metadata
- Query reputation scores (0-100)
- Trust levels: **high** (>=75), **medium** (>=40), **low** (<40)

> **Note:** ERC-8004 identity features only work on Avalanche C-Chain (chain ID 43114).

### Interop — Full ERC-8004 Identity Resolution (v1.1.0)

Resolve full agent registration files from on-chain `agentURI`, discover service endpoints, verify domain bindings, and reverse-resolve agents from wallet addresses.

```typescript
const agent = new Evalanche({ privateKey: '0x...', network: 'avalanche' });

// Resolve full agent registration (services, wallet, trust modes)
const resolver = agent.interop();
const registration = await resolver.resolveAgent(1599);
// → { name, description, agentWallet, services: [...], active, x402Support, supportedTrust }

// Get all service endpoints
const services = await resolver.getServiceEndpoints(1599);
// → [{ name: 'A2A', endpoint: 'https://...' }, { name: 'MCP', endpoint: '...' }]

// Get preferred transport (A2A > XMTP > MCP > web)
const preferred = await resolver.getPreferredTransport(1599);
// → { transport: 'A2A', endpoint: 'https://agent.example.com/a2a' }

// Get agent payment wallet
const wallet = await resolver.resolveAgentWallet(1599);

// Verify endpoint domain binding
const verification = await resolver.verifyEndpointBinding(1599, 'https://agent.example.com/api');
// → { verified: true }

// Reverse resolve: find agent ID from wallet address
const agentId = await resolver.resolveByWallet('0x...');
```

Supports `ipfs://`, `https://`, and `data:` URI schemes for agent registration files.

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
| `platform_cli_available` | Check if platform-cli is installed |
| `subnet_create` | Create a new subnet |
| `subnet_convert_l1` | Convert subnet to L1 blockchain |
| `subnet_transfer_ownership` | Transfer subnet ownership |
| `add_validator` | Add validator with BLS keys |
| `l1_register_validator` | Register L1 validator |
| `l1_add_balance` | Add L1 validator balance |
| `l1_disable_validator` | Disable L1 validator |
| `node_info` | Get NodeID + BLS from running node |
| `pchain_send` | Send AVAX on P-Chain |
| `arena_buy` | Buy Arena community tokens |
| `arena_sell` | Sell Arena community tokens |
| `arena_token_info` | Get Arena token info |
| `arena_buy_cost` | Calculate Arena buy cost |
| `approve_and_call` | Approve ERC-20 and execute follow-up contract call |
| `upgrade_proxy` | Execute UUPS `upgradeToAndCall` proxy upgrade |
| `dydx_get_markets` | List dYdX perpetual markets |
| `dydx_has_market` | Check if perp market exists |
| `dydx_get_balance` | Get dYdX USDC balance |
| `dydx_get_positions` | Get open perp positions |
| `dydx_place_market_order` | Place dYdX market order |
| `dydx_place_limit_order` | Place dYdX limit order |
| `dydx_cancel_order` | Cancel dYdX order |
| `dydx_close_position` | Close perp position |
| `dydx_get_orders` | List dYdX orders |
| `find_perp_market` | Search perp markets across venues |
| `check_bridge_status` | Poll cross-chain transfer status |
| `lifi_swap_quote` | Get same-chain DEX swap quote |
| `lifi_swap` | Execute same-chain DEX swap |
| `lifi_get_tokens` | List tokens on specified chains |
| `lifi_get_token` | Get token info (symbol, price, decimals) |
| `lifi_get_chains` | List all Li.Fi supported chains |
| `lifi_get_tools` | List available bridges and DEXs |
| `lifi_gas_prices` | Get gas prices across all chains |
| `lifi_gas_suggestion` | Get gas suggestion for a chain |
| `lifi_get_connections` | Discover transfer paths between chains |
| `lifi_compose` | Cross-chain DeFi Composer (bridge + vault/stake/lend) |
| `resolve_agent_registration` | Resolve full ERC-8004 agent registration file |
| `get_agent_services` | List service endpoints for an agent |
| `get_agent_wallet` | Get agent payment wallet address |
| `verify_agent_endpoint` | Verify endpoint domain binding |
| `resolve_by_wallet` | Find agent ID from wallet address |

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
│  └────┬──────────────────────────────────────┘  │
│       │                                          │
│  ┌────┴──────────────────────────────────────┐  │
│  │  Platform CLI (optional subprocess)       │  │
│  │  Subnets │ L1 Validators │ BLS Staking    │  │
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

### v0.4.0
- Multi-EVM support (21+ chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, etc.)
- Routescan RPCs as preferred provider
- Li.Fi cross-chain bridging
- Gas.zip destination gas funding
- Network switching
- 17 MCP tools (7 new)

### v0.5.0
- Arena DEX swap module (buy/sell community tokens via bonding curve)
- 4 new MCP tools (arena_buy, arena_sell, arena_token_info, arena_buy_cost)

### v0.6.0
- Platform CLI integration (wraps ava-labs/platform-cli as optional subprocess)
- Subnet management (create, transfer ownership, convert to L1)
- L1 validator operations (register, set-weight, add-balance, disable)
- Enhanced staking with BLS keys + node endpoint auto-discovery
- P-Chain direct send, chain creation, node info
- 10 new MCP tools (27 total)

### v0.7.0
- **dYdX v4 perpetual futures** — trade 100+ perp markets via Cosmos-based dYdX chain
- `DydxClient` wrapping `@dydxprotocol/v4-client-js` (wallet derived from same mnemonic)
- `PerpVenue` interface — extensible for adding Hyperliquid, Vertex, etc.
- Market/limit orders, positions, balance, deposit/withdraw
- `findPerpMarket(ticker)` — search across all connected perp venues
- 10 new MCP tools (37 total), 164 tests

### v0.8.0
- **Full Li.Fi cross-chain liquidity SDK** — expanded from bridge-only to complete integration
- Same-chain DEX swaps via Li.Fi (31+ DEX aggregators on any chain)
- Transfer status tracking (poll PENDING/DONE/FAILED after bridge tx)
- Token discovery (list/lookup tokens with prices across all chains)
- Chain discovery (all Li.Fi supported chains)
- Bridge/DEX tool listing (available bridges and exchanges)
- Gas prices and suggestions per chain
- Connection discovery (possible transfer paths between chains)
- **DeFi Composer/Zaps** — one-tx cross-chain DeFi (bridge + deposit into Morpho/Aave V3/Euler/Pendle/Lido/EtherFi/etc.)
- 11 new MCP tools (52 total), 180 tests

### v0.9.0
- Contract interaction helpers: `approveAndCall()` and `upgradeProxy()`
- New MCP tools: `approve_and_call`, `upgrade_proxy`
- Gap 1 and Gap 2 marked resolved in `GAPS.md`
- 2 new MCP tools (54 total)

### v1.0.0
- **Agent Economy Layer** — spending policies, discovery, negotiation, settlement, escrow, persistent memory
- 15 new MCP tools (69 total), 325 tests

### v1.1.0 (current)
- **ERC-8004 full identity resolution** — interop layer Phase 7
- `InteropIdentityResolver`: resolve agent registration files from on-chain `agentURI`
- Service endpoint discovery, preferred transport selection (A2A > XMTP > MCP > web)
- Agent wallet resolution (on-chain metadata + registration file fallback)
- Endpoint domain verification via `.well-known/agent-registration.json`
- Reverse resolution: find agent ID from wallet address
- Supports `ipfs://`, `https://`, `data:` URI schemes
- 5 new MCP tools (74 total), 372 tests

### v2.0 (planned)
- A2A protocol support (Agent Cards, task lifecycle)
- XMTP transport layer (wallet-bound async messaging)
- Signed service manifests and canonical receipts

## License

MIT
