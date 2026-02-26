---
name: evalanche
description: >
  Non-custodial agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402).
  Agents generate and manage their own keys — no human input required.
  Use when: booting an autonomous agent wallet, sending AVAX, calling contracts, resolving agent identity,
  checking reputation, making x402 payment-gated API calls, cross-chain transfers (C↔X↔P),
  delegating stake, querying validators, signing messages.
  Don't use when: trading on DEXes (use bankr), bridging to non-Avalanche chains (use lifi-bridge),
  managing ENS (use moltbook scripts).
  Network: yes (Avalanche RPC). Cost: gas fees per transaction.
metadata:
  {
    "openclaw":
      {
        "emoji": "🏔️",
        "homepage": "https://github.com/iJaack/evalanche",
        "source": "https://github.com/iJaack/evalanche",
        "requires": { "bins": ["node"] },
        "env":
          [
            {
              "name": "AGENT_PRIVATE_KEY",
              "description": "Hex-encoded private key (C-Chain only). Optional if using boot() or AGENT_MNEMONIC.",
              "required": false,
              "secret": true,
            },
            {
              "name": "AGENT_MNEMONIC",
              "description": "BIP-39 mnemonic phrase (required for multi-VM X/P-Chain). Optional if using boot() or AGENT_PRIVATE_KEY.",
              "required": false,
              "secret": true,
            },
            {
              "name": "AGENT_ID",
              "description": "ERC-8004 agent token ID for identity resolution.",
              "required": false,
            },
            {
              "name": "AGENT_KEYSTORE_DIR",
              "description": "Directory for encrypted keystore in boot() mode. Default: ~/.evalanche/keys",
              "required": false,
            },
            {
              "name": "AVALANCHE_NETWORK",
              "description": "Network: 'avalanche' (mainnet) or 'fuji' (testnet). Default: avalanche.",
              "required": false,
            },
          ],
        "configPaths": ["~/.evalanche/keys/agent.json"],
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

**Source:** https://github.com/iJaack/evalanche
**License:** MIT

## Security Model

### Key Storage & Encryption

`Evalanche.boot()` manages keys autonomously with **encrypted-at-rest** storage:

1. **First run:** Generates a BIP-39 mnemonic via `ethers.HDNodeWallet.createRandom()` (uses Node.js `crypto.randomBytes` for entropy)
2. **Encryption:** Wallet is encrypted using ethers v6 keystore format (**AES-128-CTR + scrypt KDF**) — same format as geth/MetaMask keystores
3. **Password derivation:** A 32-byte random entropy file is generated via `crypto.randomBytes(32)` and stored alongside the keystore. The encryption password is derived from this entropy. No human-set passwords.
4. **File permissions:** Both keystore (`agent.json`) and entropy file (`.agent.json.entropy`) are written with **chmod 0o600** (owner read/write only)
5. **Storage location:** `~/.evalanche/keys/` by default, configurable via `AGENT_KEYSTORE_DIR` or `keystore.dir` option

**What this means:**
- Private keys and mnemonics are **never stored in plaintext** on disk
- The entropy file IS the password material — if an attacker gets both the keystore and entropy file, they can decrypt the wallet
- Protection relies on OS-level file permissions (0o600) and filesystem access controls
- For higher security, mount `~/.evalanche/keys/` on an encrypted volume or use `AGENT_PRIVATE_KEY` env var with your own secret management (Vault, AWS KMS, etc.)

### MCP Server Access Controls

- **Stdio mode (default):** Communicates only via stdin/stdout. No network exposure. Safe for local use with Claude Desktop, Cursor, etc.
- **HTTP mode (`--http`):** Binds to `localhost:3402` by default. **Do not expose to public networks without a reverse proxy and authentication.** The HTTP endpoint has no built-in auth — it is designed for local/trusted network use only. For production, put it behind nginx/caddy with TLS + API key auth.

### Environment Variables

All env vars are **optional**. Three modes of operation:
1. **`boot()` mode** (no env vars): Agent generates and manages its own encrypted keystore
2. **Explicit keys** (`AGENT_PRIVATE_KEY` or `AGENT_MNEMONIC`): You provide keys via env vars or secret management
3. **Keystore path** (`AGENT_KEYSTORE_DIR`): Point to an existing keystore directory

## Setup

### 1. Install
```bash
npm install -g evalanche
```

Verify the package source matches the GitHub repo before installing:
```bash
npm info evalanche repository.url  # Should show github.com/iJaack/evalanche
```

### 2. Boot (non-custodial — no config needed)

```javascript
import { Evalanche } from 'evalanche';

// First run: generates wallet + encrypts to ~/.evalanche/keys/agent.json
// Every subsequent run: decrypts and loads existing wallet
const { agent, keystore } = await Evalanche.boot({
  network: 'avalanche',
  identity: { agentId: '1599' },
});

console.log(agent.address);        // 0x... (same every time)
console.log(keystore.isNew);       // true first time, false after
console.log(keystore.keystorePath); // ~/.evalanche/keys/agent.json
```

### 2b. With existing keys (optional)
```bash
export AGENT_PRIVATE_KEY="0x..."       # For C-Chain only
export AGENT_MNEMONIC="word1 word2..." # For multi-VM (X/P/C chains)
export AGENT_ID="1599"                  # ERC-8004 agent ID
export AVALANCHE_NETWORK="avalanche"    # or "fuji" for testnet
```

```javascript
const agent = new Evalanche({
  privateKey: process.env.AGENT_PRIVATE_KEY,
  network: 'avalanche',
  identity: { agentId: '1599' },
});
```

### 3. Run as MCP server (optional)
```bash
# Stdio mode (recommended — no network exposure)
evalanche-mcp

# HTTP mode (localhost only — do NOT expose publicly without auth)
evalanche-mcp --http --port 3402
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
const { Avalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY });
agent.send({ to: '0xRECIPIENT', value: '0.1' }).then(r => console.log('tx:', r.hash));
"
```

### Cross-chain transfer (requires mnemonic)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ mnemonic: process.env.AGENT_MNEMONIC, multiVM: true });
agent.transfer({ from: 'C', to: 'P', amount: '25' })
  .then(r => console.log('export:', r.exportTxId, 'import:', r.importTxId));
"
```

## Key Concepts

### ERC-8004 Agent Identity
- On-chain agent identity registry on Avalanche C-Chain
- Agent ID → tokenURI, owner, reputation score (0-100), trust level
- Trust levels: **high** (≥75), **medium** (≥40), **low** (<40), **unknown** (null)
- Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

### x402 Payment Protocol
- HTTP 402 Payment Required → parse requirements → sign payment → retry
- `maxPayment` prevents overspending
- Automatic flow: request → 402 → pay → retry with proof

### Multi-VM (X-Chain, P-Chain)
- Requires **mnemonic** (not just private key) — derives X/P keys via m/44'/9000'/0'
- C-Chain: EVM (ethers v6), X-Chain: AVM (UTXO), P-Chain: PVM (staking)
- Cross-chain transfers use atomic export/import

## Contracts

| Contract | Address | Chain |
|----------|---------|-------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | AVAX C-Chain (43114) |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | AVAX C-Chain (43114) |

## Networks

| Network | RPC | Chain ID |
|---------|-----|----------|
| Avalanche Mainnet | `https://api.avax.network/ext/bc/C/rpc` | 43114 |
| Fuji Testnet | `https://api.avax-test.network/ext/bc/C/rpc` | 43113 |
