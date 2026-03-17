---
name: evalanche
description: >
  Multi-EVM agent wallet SDK with onchain identity (ERC-8004), payment rails (x402),
  cross-chain liquidity (Li.Fi bridging + DEX aggregation + DeFi Composer), destination gas funding (Gas.zip),
  perpetual futures trading (dYdX v4), and DeFi operations (liquid staking + EIP-4626 vaults).
  Supports 21+ EVM chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, and more.
  Agents generate and manage their own keys — no human input required.
  Use when: booting an autonomous agent wallet on any EVM chain, sending tokens, calling contracts,
  resolving agent identity, checking reputation, making x402 payment-gated API calls,
  bridging tokens cross-chain (Li.Fi), same-chain DEX swaps (31+ aggregators via Li.Fi),
  one-click DeFi operations (Composer: bridge + deposit into Morpho/Aave/Pendle/Lido/etc),
  tracking cross-chain transfer status, discovering tokens and prices across chains,
  querying gas prices, finding available bridges and DEX aggregators,
  funding gas on destination chains (Gas.zip),
  cross-chain transfers (Avalanche C↔X↔P), delegating stake, querying validators, signing messages,
  creating subnets, managing L1 validators, adding validators with BLS keys, querying node info,
  trading perpetual futures on dYdX v4 (100+ markets), searching for perp markets across venues,
  staking/unstaking sAVAX via Benqi, depositing/withdrawing from EIP-4626 vaults (yoUSD, Morpho, Aave, etc).
  Don't use when: managing ENS (use moltbook scripts).
  Network: yes (EVM RPCs via Routescan + public fallbacks, dYdX Cosmos chain). Cost: gas fees per transaction.
metadata:
  {
    "openclaw":
      {
        "emoji": "⛓️",
        "homepage": "https://github.com/iJaack/evalanche",
        "source": "https://github.com/iJaack/evalanche",
        "requires": { "bins": ["node"] },
        "env":
          [
            {
              "name": "AGENT_PRIVATE_KEY",
              "description": "Hex-encoded private key (EVM). Optional if using boot() or AGENT_MNEMONIC.",
              "required": false,
              "secret": true,
            },
            {
              "name": "AGENT_MNEMONIC",
              "description": "BIP-39 mnemonic phrase (required for Avalanche multi-VM X/P-Chain). Optional if using boot() or AGENT_PRIVATE_KEY.",
              "required": false,
              "secret": true,
            },
            {
              "name": "AGENT_ID",
              "description": "ERC-8004 agent token ID for identity resolution (Avalanche C-Chain only).",
              "required": false,
            },
            {
              "name": "AGENT_KEYSTORE_DIR",
              "description": "Directory for encrypted keystore in boot() mode. Default: ~/.evalanche/keys",
              "required": false,
            },
            {
              "name": "AVALANCHE_NETWORK",
              "description": "EVM chain alias: 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'fuji', etc. Default: avalanche.",
              "required": false,
            },
            {
              "name": "EVM_CHAIN",
              "description": "Alias for AVALANCHE_NETWORK. EVM chain to connect to.",
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

# Evalanche — Multi-EVM Agent Wallet

Headless wallet SDK with ERC-8004 identity, x402 payments, Li.Fi cross-chain liquidity (bridging + DEX aggregation + DeFi Composer), Gas.zip gas funding, dYdX v4 perpetuals, contract interaction helpers (approve-and-call + UUPS upgrade), and DeFi operations (liquid staking + EIP-4626 vaults). Works on 21+ EVM chains. 91 MCP tools. Works as CLI or MCP server.

**Source:** https://github.com/iJaack/evalanche
**License:** MIT

## Supported Chains

Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Fantom, Gnosis, zkSync Era, Linea, Scroll, Blast, Mantle, Celo, Moonbeam, Cronos, Berachain, + testnets (Fuji, Sepolia, Base Sepolia).

Routescan RPCs preferred where available, with public fallback RPCs.

## Security Model

### Key Storage & Encryption

`Evalanche.boot()` manages keys autonomously with **encrypted-at-rest** storage:

1. **First run:** Generates a BIP-39 mnemonic via `ethers.HDNodeWallet.createRandom()`
2. **Encryption:** AES-128-CTR + scrypt KDF (geth-compatible keystore format)
3. **Password derivation:** 32-byte random entropy file via `crypto.randomBytes(32)`
4. **File permissions:** chmod 0o600 (owner read/write only)
5. **Storage location:** `~/.evalanche/keys/` by default

### MCP Server Access Controls

- **Stdio mode (default):** stdin/stdout only. No network exposure.
- **HTTP mode (`--http`):** localhost:3402. Do not expose publicly without auth.

### OpenClaw External Secrets (Preferred when available)

Priority: OpenClaw secrets → raw env vars → encrypted keystore.

## Setup

### 1. Install
```bash
npm install -g evalanche
```

### 2. Boot on any chain
```javascript
import { Evalanche } from 'evalanche';

// Base
const { agent } = await Evalanche.boot({ network: 'base' });

// Ethereum
const { agent: eth } = await Evalanche.boot({ network: 'ethereum' });

// Arbitrum
const { agent: arb } = await Avalanche.boot({ network: 'arbitrum' });

// Avalanche (with identity)
const { agent: avax } = await Evalanche.boot({
  network: 'avalanche',
  identity: { agentId: '1599' },
});
```

### 3. Run as MCP server
```bash
AVALANCHE_NETWORK=base evalanche-mcp
```

## Available Tools (MCP)

### Wallet
| Tool | Description |
|------|-------------|
| `get_address` | Get agent wallet address |
| `get_balance` | Get native token balance |
| `sign_message` | Sign arbitrary message |
| `send_avax` | Send native tokens |
| `call_contract` | Call a contract method |

### Identity (ERC-8004)
| Tool | Description |
|------|-------------|
| `resolve_identity` | Resolve agent identity + reputation |
| `resolve_agent` | Look up any agent by ID |

### Payments (x402)
| Tool | Description |
|------|-------------|
| `pay_and_fetch` | x402 payment-gated HTTP request |

### Reputation
| Tool | Description |
|------|-------------|
| `submit_feedback` | Submit on-chain reputation feedback |

### Network & Chains
| Tool | Description |
|------|-------------|
| `get_network` | Get current network config |
| `get_supported_chains` | List all 21+ supported chains |
| `get_chain_info` | Get details for a specific chain |
| `switch_network` | Switch to different EVM chain |

### Arena DEX (Avalanche)
| Tool | Description |
|------|-------------|
| `arena_buy` | Buy Arena community tokens via bonding curve (spends $ARENA) |
| `arena_sell` | Sell Arena community tokens for $ARENA |
| `arena_token_info` | Get token info (fees, curve params) by address |
| `arena_buy_cost` | Calculate $ARENA cost for a given buy amount (read-only) |

### Contract Interaction Helpers (v0.9.0)
| Tool | Description |
|------|-------------|
| `approve_and_call` | Approve ERC-20 spending, then execute a follow-up contract call |
| `upgrade_proxy` | Upgrade a UUPS proxy via `upgradeToAndCall` |

### Bridging & Cross-Chain
| Tool | Description |
|------|-------------|
| `get_bridge_quote` | Get cross-chain bridge quote (Li.Fi) |
| `get_bridge_routes` | Get all bridge route options |
| `bridge_tokens` | Bridge tokens between chains |
| `check_bridge_status` | Poll cross-chain transfer status (PENDING/DONE/FAILED) |
| `fund_destination_gas` | Fund gas via Gas.zip |

### Li.Fi Liquidity SDK (v0.8.0)
| Tool | Description |
|------|-------------|
| `lifi_swap_quote` | Get same-chain DEX swap quote (31+ aggregators) |
| `lifi_swap` | Execute same-chain DEX swap |
| `lifi_get_tokens` | List tokens with prices on specified chains |
| `lifi_get_token` | Get specific token info (symbol, decimals, priceUSD) |
| `lifi_get_chains` | List all Li.Fi supported chains |
| `lifi_get_tools` | List available bridges and DEX aggregators |
| `lifi_gas_prices` | Get gas prices across all chains |
| `lifi_gas_suggestion` | Get gas suggestion for a specific chain |
| `lifi_get_connections` | Discover possible transfer paths between chains |
| `lifi_compose` | Cross-chain DeFi Composer (bridge + deposit into Morpho/Aave/Pendle/Lido/etc in one tx) |

### Platform CLI (requires `platform-cli` binary — `go install github.com/ava-labs/platform-cli@latest`)
| Tool | Description |
|------|-------------|
| `platform_cli_available` | Check if platform-cli is installed |
| `subnet_create` | Create a new Avalanche subnet |
| `subnet_convert_l1` | Convert subnet to L1 blockchain |
| `subnet_transfer_ownership` | Transfer subnet ownership |
| `add_validator` | Add validator with BLS keys to Primary Network |
| `l1_register_validator` | Register a new L1 validator |
| `l1_add_balance` | Add balance to L1 validator |
| `l1_disable_validator` | Disable an L1 validator |
| `node_info` | Get NodeID + BLS keys from running node |
| `pchain_send` | Send AVAX on P-Chain (P→P) |

### dYdX v4 Perpetuals (v0.7.0 — requires mnemonic)
| Tool | Description |
|------|-------------|
| `dydx_get_markets` | List all dYdX perpetual markets with prices/leverage |
| `dydx_has_market` | Check if a specific perp market exists (e.g. AKT-USD) |
| `dydx_get_balance` | Get USDC equity on dYdX subaccount |
| `dydx_get_positions` | Get all open perpetual positions |
| `dydx_place_market_order` | Place a market order (BUY/SELL) |
| `dydx_place_limit_order` | Place a limit order |
| `dydx_cancel_order` | Cancel an open order |
| `dydx_close_position` | Close position with reduce-only market order |
| `dydx_get_orders` | List orders (optionally filter by status) |
| `find_perp_market` | Search for a market across all connected perp venues |

## Programmatic Usage

### Check balance on Base
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY, network: 'base' });
agent.provider.getBalance(agent.address).then(b => {
  const { formatEther } = require('ethers');
  console.log(formatEther(b) + ' ETH');
});
"
```

### Bridge tokens (Ethereum → Arbitrum)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY, network: 'ethereum' });
agent.bridgeTokens({
  fromChainId: 1, toChainId: 42161,
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0x0000000000000000000000000000000000000000',
  fromAmount: '0.1', fromAddress: agent.address,
}).then(r => console.log('tx:', r.txHash));
"
```

### Same-chain DEX swap (ETH → USDC on Base)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY, network: 'base' });
agent.swap({
  fromChainId: 8453, toChainId: 8453,
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  fromAmount: '0.05', fromAddress: agent.address,
}).then(r => console.log('swap tx:', r.txHash));
"
```

### Track bridge transfer status
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY, network: 'ethereum' });
agent.checkBridgeStatus({ txHash: '0x...', fromChainId: 1, toChainId: 8453 })
  .then(s => console.log(s.status, s.substatus));
"
```

### Token discovery
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ privateKey: process.env.AGENT_PRIVATE_KEY, network: 'base' });
agent.getToken(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  .then(t => console.log(t.symbol, t.priceUSD));
"
```

### Cross-chain transfer on Avalanche (requires mnemonic)
```bash
node -e "
const { Evalanche } = require('evalanche');
const agent = new Evalanche({ mnemonic: process.env.AGENT_MNEMONIC, multiVM: true });
agent.transfer({ from: 'C', to: 'P', amount: '25' })
  .then(r => console.log('export:', r.exportTxId, 'import:', r.importTxId));
"
```

## Key Concepts

### ERC-8004 Agent Identity (Avalanche only)
- On-chain agent identity registry on Avalanche C-Chain
- Agent ID → tokenURI, owner, reputation score (0-100), trust level
- Trust levels: **high** (≥75), **medium** (≥40), **low** (<40)

### Li.Fi Cross-Chain Liquidity (v0.8.0)
- **Bridging:** Aggregated routes across 27+ bridges (Across, Stargate, Hop, etc.)
- **DEX Aggregation:** Same-chain swaps via 31+ DEX aggregators (1inch, Paraswap, Jupiter, etc.)
- **DeFi Composer:** One-tx cross-chain DeFi (bridge + deposit into Morpho, Aave V3, Euler, Pendle, Lido wstETH, EtherFi, etc.)
- **Status Tracking:** Poll transfer status (PENDING → DONE/FAILED with substatus)
- **Token Discovery:** List/lookup tokens with prices across all chains
- **Gas Pricing:** Gas prices and suggestions per chain
- Uses Li.Fi REST API (no SDK dependency needed)

### Gas.zip
- Cheap cross-chain gas funding
- Send gas to any destination chain via deposit addresses

### x402 Payment Protocol
- HTTP 402 Payment Required → parse requirements → sign payment → retry
- `maxPayment` prevents overspending

### Multi-VM (Avalanche X-Chain, P-Chain)
- Requires **mnemonic** and `network: 'avalanche'` or `'fuji'`
- C-Chain: EVM (ethers v6), X-Chain: AVM (UTXO), P-Chain: PVM (staking)

## Contracts

| Contract | Address | Chain |
|----------|---------|-------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | AVAX C-Chain (43114) |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | AVAX C-Chain (43114) |
| sAVAX (Benqi) | `0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE` | AVAX C-Chain (43114) |
| yoUSD Vault | `0x0000000f2eb9f69274678c76222b35eec7588a65` | Base (8453) |

### DeFi — Liquid Staking & EIP-4626 Vaults (v1.2.0)

```javascript
const { agent } = await Evalanche.boot({ network: 'avalanche' });
const { staking, vaults } = agent.defi();

// sAVAX unstake (instant if pool available, delayed otherwise)
const q = await staking.sAvaxUnstakeQuote('5');
// { avaxOut, isInstant, poolBalance, minOutput }
await staking.sAvaxUnstakeInstant('5');   // redeemInstant on Benqi
await staking.sAvaxUnstakeDelayed('5');   // requestRedeem (no pool needed)

// Stake AVAX → sAVAX
await staking.sAvaxStake('10', 50);  // 50bps slippage

// EIP-4626 vault deposit (any chain)
const YOUSD = '0x0000000f2eb9f69274678c76222b35eec7588a65';
const baseAgent = new Evalanche({ privateKey: '0x...', network: 'base' });
const { vaults: baseVaults } = baseAgent.defi();
await baseVaults.deposit(YOUSD, '1000', 'base');   // approve + deposit
await baseVaults.withdraw(YOUSD, '998', 'base');    // redeem shares
```

**MCP tools (defi):**
`savax_stake_quote`, `savax_stake`, `savax_unstake_quote`, `savax_unstake`,
`vault_info`, `vault_deposit_quote`, `vault_deposit`, `vault_withdraw_quote`, `vault_withdraw`
