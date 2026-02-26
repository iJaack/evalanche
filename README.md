# 🏔️ Evalanche

**Agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402)**

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

## License

MIT
