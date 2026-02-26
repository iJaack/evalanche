# 🏔️ Evalanche

**Agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402)**

Evalanche gives AI agents a **non-custodial** wallet on Avalanche with built-in onchain identity and payment capabilities — no browser, no popups, no human in the loop. The agent generates its own keys, encrypts them at rest, and manages its own key lifecycle.

## Background

Evalanche's architecture is informed by [Ava Labs' Core Extension](https://github.com/ava-labs/core-extension) wallet — specifically its service-worker signing patterns, network management, and multi-secret-type design (mnemonic, Ledger, Fireblocks, seedless). We studied Core Extension's `WalletService`, `AccountsService`, and `NetworkService` to understand how Core handles transaction signing and account derivation, then rebuilt these patterns as a headless SDK optimized for agent use cases.

A companion [Core Extension PR](https://github.com/iJaack/core-extension/tree/feat/erc8004-agent-identity) adds ERC-8004 agent identity resolution directly into the Core wallet approval UI, so humans can see an agent's on-chain reputation when approving transactions.

## Install

```bash
npm install evalanche
```

## Quick Start

### Non-custodial (recommended) — agent manages its own keys

```typescript
import { Evalanche } from 'evalanche';

// First run: generates wallet, encrypts to ~/.evalanche/keys/agent.json
// Every subsequent run: decrypts and loads the same wallet
const { agent, keystore } = await Evalanche.boot({
  network: 'avalanche',
  identity: {
    agentId: '1599',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
});

console.log(agent.address);       // 0x... (same every time)
console.log(keystore.isNew);      // true first run, false after
console.log(keystore.keystorePath); // ~/.evalanche/keys/agent.json

// Send AVAX
await agent.send({ to: '0x...', value: '0.1' });

// Sign messages
await agent.signMessage('Hello from my autonomous agent');
```

No human ever sees the private key or mnemonic. Keys are encrypted at rest with AES-128-CTR + scrypt (geth-compatible keystore format), password derived from machine-local entropy (chmod 600).

### One-shot generation (returns plaintext keys)

```typescript
// For scripts or testing — caller is responsible for key storage
const { agent, wallet } = Evalanche.generate({ network: 'fuji' });
console.log(wallet.mnemonic);   // 12-word BIP-39
console.log(wallet.privateKey); // 0x...
console.log(wallet.address);    // 0x...
```

### Existing keys

```typescript
const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche',
});
```

## API Reference

### `Evalanche.boot(options?): Promise<{ agent, keystore }>`

**Non-custodial autonomous boot.** Generates or loads an encrypted keystore. No human input.

| Option | Type | Description |
|--------|------|-------------|
| `network` | `'avalanche' \| 'fuji' \| { rpcUrl, chainId }` | Network (default: `'avalanche'`) |
| `identity` | `{ agentId, registry? }` | Optional ERC-8004 identity config |
| `multiVM` | `boolean` | Enable X-Chain / P-Chain support |
| `keystore.dir` | `string` | Keystore directory (default: `~/.evalanche/keys`) |
| `keystore.filename` | `string` | Keystore filename (default: `agent.json`) |

### `Evalanche.generate(options?): { agent, wallet }`

**One-shot generation.** Returns plaintext keys — caller handles storage.

### `new Evalanche(config)`

Create an agent with existing keys.

| Option | Type | Description |
|--------|------|-------------|
| `privateKey` | `string` | Hex-encoded private key |
| `mnemonic` | `string` | BIP-39 mnemonic phrase |
| `network` | `'avalanche' \| 'fuji' \| { rpcUrl, chainId }` | Network (default: `'avalanche'`) |
| `identity` | `{ agentId, registry? }` | Optional ERC-8004 identity config |
| `multiVM` | `boolean` | Enable X-Chain / P-Chain support |

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

## Multi-VM (X-Chain, P-Chain)

Multi-VM support requires a **mnemonic** (not just a private key) to derive X/P-Chain keys.

```typescript
const agent = new Evalanche({
  mnemonic: process.env.AGENT_MNEMONIC,
  network: 'avalanche',
  multiVM: true,
});

// Get balances across all chains
const balances = await agent.getMultiChainBalance();
// { C: '10.5', X: '0.0', P: '25.0', total: '35.5' }

// Get addresses on all chains
const addrs = await agent.getAddresses();
// { C: '0x...', X: 'X-avax1...', P: 'P-avax1...' }

// Cross-chain transfer (C→P for staking)
const result = await agent.transfer({ from: 'C', to: 'P', amount: '25' });
// { exportTxId: '...', importTxId: '...' }

// Delegate to a validator (30 days)
const txId = await agent.delegate('NodeID-...', '25', 30);

// Check stake
const stakes = await agent.getStake();

// Query validators
const validators = await agent.getValidators(10);

// Direct chain access
const xChain = await agent.xChain();
const pChain = await agent.pChain();
const xAddr = xChain.getAddress();
```

> **Note:** Avalanche dependencies (`@avalabs/core-wallets-sdk`) are lazy-loaded on first multi-VM call. If you only use C-Chain features, they're never loaded.

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Evalanche                   │
│                                             │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Keystore │ │ Identity │ │ Reputation │  │
│  │(AES+scry)│ │ Resolver │ │  Reporter  │  │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘  │
│       │             │             │          │
│  ┌────┴─────┐ ┌────┴─────┐       │          │
│  │  Wallet  │ │ ERC-8004 │       │          │
│  │  Signer  │ │ Registry │       │          │
│  └────┬─────┘ └──────────┘       │          │
│       │                           │          │
│  ┌────┴─────┐ ┌──────────────────┴──────┐   │
│  │   Tx     │ │      x402 Client        │   │
│  │ Builder  │ │ (Pay-gated HTTP + Fac.) │   │
│  └────┬─────┘ └─────────────────────────┘   │
│       │                                      │
│  ┌────┴──────────────────────────────────┐  │
│  │  C-Chain (EVM) │ X-Chain │ P-Chain    │  │
│  │  ethers v6     │ avalanchejs v5       │  │
│  └───────────────────────────────────────┘  │
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
| `AGENT_PRIVATE_KEY` | No* | Agent wallet private key |
| `AGENT_MNEMONIC` | No* | BIP-39 mnemonic (alternative) |
| `AGENT_KEYSTORE_DIR` | No* | Path to keystore directory for `boot()` mode |
| `AGENT_ID` | No | ERC-8004 agent ID (enables identity resolution) |
| `AGENT_REGISTRY` | No | Custom ERC-8004 registry address |
| `AVALANCHE_NETWORK` | No | `avalanche` (default) or `fuji` |
| `AVALANCHE_RPC_URL` | No | Custom RPC URL |

\* Provide one of: `AGENT_PRIVATE_KEY`, `AGENT_MNEMONIC`, or `AGENT_KEYSTORE_DIR`. If none is set, the MCP server uses `boot()` mode with the default keystore path (`~/.evalanche/keys/agent.json`).

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

### v0.1.0
- ✅ C-Chain wallet (ethers v6) — send AVAX, call contracts, sign messages
- ✅ ERC-8004 identity resolution — agent ID, reputation, trust levels
- ✅ x402 payment-gated HTTP client — full 402 flow
- ✅ On-chain reputation feedback submission
- ✅ MCP server (stdio + HTTP) — 10 tools for AI frameworks

### v0.2.0
- ✅ Integrated `@avalabs/avalanchejs` v5 for native X-Chain and P-Chain support
- ✅ Integrated `@avalabs/core-wallets-sdk` v3 for Core-compatible account derivation
- ✅ Cross-chain transfers — all 6 directions (C↔X↔P) via atomic export/import
- ✅ P-Chain staking — delegate to validators, query stake, get min amounts
- ✅ Multi-VM signing via StaticSigner (EVM + AVM + PVM from one mnemonic)
- ✅ Multi-chain balance queries (C + X + P totals)
- ✅ Lazy-loaded Avalanche deps — zero overhead if only using C-Chain

### v0.3.0 (current)
- ✅ Non-custodial `AgentKeystore` — encrypted-at-rest key storage (AES-128-CTR + scrypt)
- ✅ `Evalanche.boot()` — fully autonomous agent lifecycle (generate → encrypt → persist → reload)
- ✅ `Evalanche.generate()` — one-shot wallet creation for scripts/testing
- ✅ Machine-local entropy for password derivation (no human-set passwords)
- ✅ `exportMnemonic()` for backup/migration only

### v0.4.0 (planned)
- [ ] Subnet/L1 support — custom network configs with VM-specific signing
- [ ] ICM (Interchain Messaging) integration
- [ ] Agent-to-agent payment channels
- [ ] Ledger/hardware wallet support (for human-supervised agent operations)

## License

MIT
