---
name: evalanche
description: >
  Agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402).
  Use when: sending AVAX, calling contracts, resolving agent identity, checking reputation,
  making x402 payment-gated API calls, cross-chain transfers (C↔X↔P), delegating stake,
  querying validators, signing messages.
  Don't use when: trading on DEXes (use bankr), bridging to non-Avalanche chains (use lifi-bridge),
  managing ENS (use moltbook scripts).
  Network: yes (Avalanche RPC). Cost: gas fees per transaction.
metadata:
  {
    "openclaw":
      {
        "emoji": "🏔️",
        "homepage": "https://github.com/iJaack/evalanche",
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "evalanche",
              "bins": ["evalanche-mcp"],
              "label": "Install evalanche (npm)",
            },
          ],
      },
  }
---

# Evalanche — Agent Wallet for Avalanche

Headless wallet SDK with ERC-8004 identity and x402 payments. Works as CLI tools or MCP server.

## Setup

### 1. Install
```bash
npm install -g evalanche
```

### 2. Configure environment
```bash
# Required: wallet key (one of these)
export AGENT_PRIVATE_KEY="0x..."       # For C-Chain only
export AGENT_MNEMONIC="word1 word2..." # For multi-VM (X/P/C chains)

# Optional: identity
export AGENT_ID="1599"                  # ERC-8004 agent ID
export AGENT_REGISTRY="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

# Optional: network
export AVALANCHE_NETWORK="avalanche"    # or "fuji" for testnet
export AVALANCHE_RPC_URL=""             # custom RPC (overrides network default)
```

### 3. Run as MCP server (optional)
```bash
# Stdio mode (for Claude Desktop, Cursor, etc.)
evalanche-mcp

# HTTP mode
evalanche-mcp --http --port 3402
```

## Using as a Library (in scripts)

```javascript
import { Evalanche } from 'evalanche';

const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche',
  identity: { agentId: '1599' },
});
```

## Available Tools (MCP)

When running as MCP server, these tools are exposed:

### Wallet
| Tool | Description |
|------|-------------|
| `get_address` | Get agent wallet address |
| `get_balance` | Get AVAX balance (C-Chain) |
| `sign_message` | Sign arbitrary message |
| `send_avax` | Send AVAX to address |
| `call_contract` | Call a contract method |

### Identity (ERC-8004)
| Tool | Description |
|------|-------------|
| `resolve_identity` | Resolve this agent's on-chain identity + reputation |
| `resolve_agent` | Look up any agent by ID |

### Payments (x402)
| Tool | Description |
|------|-------------|
| `pay_and_fetch` | Make x402 payment-gated HTTP request |

### Reputation
| Tool | Description |
|------|-------------|
| `submit_feedback` | Submit on-chain reputation feedback for another agent |

### Network
| Tool | Description |
|------|-------------|
| `get_network` | Get current network config |

## Programmatic Usage (without MCP)

For direct usage in shell scripts or Node.js:

### Check balance
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY });
agent.provider.getBalance(agent.address).then(b => {
  const { formatEther } = require('ethers');
  console.log(formatEther(b) + ' AVAX');
});
"
```

### Send AVAX
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY });
agent.send({ to: '0xRECIPIENT', value: '0.1' }).then(r => console.log('tx:', r.hash));
"
```

### Resolve agent identity
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  identity: { agentId: '1599' },
});
agent.resolveIdentity().then(id => console.log(JSON.stringify(id, null, 2)));
"
```

### x402 payment-gated request
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY });
agent.payAndFetch('https://api.example.com/data', { maxPayment: '0.01' })
  .then(r => console.log(r.body));
"
```

### Cross-chain transfer (requires mnemonic)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({
  mnemonic: process.env.AGENT_MNEMONIC,
  multiVM: true,
});
agent.transfer({ from: 'C', to: 'P', amount: '25' })
  .then(r => console.log('export:', r.exportTxId, 'import:', r.importTxId));
"
```

### Delegate stake (requires mnemonic)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({
  mnemonic: process.env.AGENT_MNEMONIC,
  multiVM: true,
});
agent.delegate('NodeID-...', '25', 30).then(tx => console.log('delegated:', tx));
"
```

## Key Concepts

### ERC-8004 Agent Identity
- On-chain agent identity registry on Avalanche C-Chain
- Agent ID → tokenURI, owner, reputation score (0-100)
- Trust levels: **high** (≥75), **medium** (≥40), **low** (<40)
- Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

### x402 Payment Protocol
- HTTP 402 Payment Required → parse requirements → sign payment → retry
- `maxPayment` prevents overspending
- Automatic flow: request → 402 → pay → retry with proof

### Multi-VM (X-Chain, P-Chain)
- Requires **mnemonic** (not just private key) — derives X/P keys via m/44'/9000'/0'
- C-Chain: EVM (ethers v6)
- X-Chain: Exchange Chain (UTXO-based, AVM)
- P-Chain: Platform Chain (staking, validators, PVM)
- Cross-chain transfers use atomic export/import (3s confirmation)

## Contracts

| Contract | Address | Chain |
|----------|---------|-------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | AVAX C-Chain |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | AVAX C-Chain |

## Networks

| Network | RPC | Chain ID |
|---------|-----|----------|
| Avalanche Mainnet | `https://api.avax.network/ext/bc/C/rpc` | 43114 |
| Fuji Testnet | `https://api.avax-test.network/ext/bc/C/rpc` | 43113 |
