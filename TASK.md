# Evalanche — Agent Wallet SDK for Avalanche

## What This Is

`evalanche` is an npm package that gives AI agents a programmatic wallet with onchain identity (ERC-8004) and payment rails (x402). Think of it as "bankr but Avalanche-native with verifiable identity."

## Package Name
`evalanche`

## Tech Stack
- TypeScript (strict mode)
- ethers v6
- Node.js >= 18
- Build: tsup (ESM + CJS)
- Tests: vitest

## Package Structure

```
evalanche/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── LICENSE (MIT)
├── src/
│   ├── index.ts              # Public API exports
│   ├── agent.ts              # Main Evalanche agent class
│   ├── identity/
│   │   ├── index.ts
│   │   ├── resolver.ts       # ERC-8004 identity resolution
│   │   ├── types.ts          # AgentIdentity, Declaration types
│   │   └── constants.ts      # Registry addresses, ABIs
│   ├── wallet/
│   │   ├── index.ts
│   │   ├── signer.ts         # Headless wallet signer (ethers v6)
│   │   ├── transaction.ts    # Transaction builder + sender
│   │   └── types.ts          # TransactionIntent, Result types
│   ├── reputation/
│   │   ├── index.ts
│   │   ├── reporter.ts       # Submit reputation feedback on-chain
│   │   └── types.ts          # Feedback types
│   ├── x402/
│   │   ├── index.ts
│   │   ├── client.ts         # x402 payment-gated HTTP client
│   │   ├── facilitator.ts    # x402 facilitator interaction
│   │   └── types.ts          # Payment types
│   └── utils/
│       ├── networks.ts       # Avalanche network configs (C-Chain, Fuji)
│       ├── cache.ts          # TTL cache utility
│       └── errors.ts         # Custom error classes
└── test/
    ├── agent.test.ts
    ├── identity/resolver.test.ts
    ├── wallet/signer.test.ts
    └── x402/client.test.ts
```

## Core API Design

```typescript
import { Evalanche } from 'evalanche';

// Initialize with private key or mnemonic
const agent = new Evalanche({
  // Wallet config
  privateKey: process.env.AGENT_PRIVATE_KEY,
  // OR: mnemonic: process.env.AGENT_MNEMONIC,
  
  // Identity config (optional — works without identity too)
  identity: {
    agentId: '1599',
    registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  
  // Network config
  network: 'avalanche', // 'avalanche' | 'fuji' | { rpcUrl, chainId }
});

// Get agent info
const address = agent.address;              // 0x0fE617...
const identity = await agent.resolveIdentity(); // { agentId, registry, reputation, trustLevel }

// Send transactions
const tx = await agent.send({
  to: '0x...',
  value: '0.1',                             // human-readable AVAX
  // OR: data: '0x...',                      // raw calldata
});

// Contract interactions
const result = await agent.call({
  contract: '0x...',
  abi: ['function transfer(address to, uint256 amount)'],
  method: 'transfer',
  args: ['0x...', '1000000'],
});

// x402 payment-gated API calls
const response = await agent.payAndFetch('https://api.example.com/data', {
  maxPayment: '0.01',                        // max AVAX willing to pay
});

// Submit reputation feedback
await agent.submitFeedback({
  targetAgentId: '42',
  taskRef: 'content-verification-001',
  score: 85,
  metadata: { contentHash: '0xabc...', verified: true },
});

// Sign messages (for auth flows)
const signature = await agent.signMessage('Login to Eva Protocol');
```

## Implementation Details

### 1. src/agent.ts — Main Class

The `Evalanche` class is the main entry point. It:
- Creates an ethers Wallet from private key or mnemonic
- Connects to the specified network (AVAX C-Chain by default)
- Lazily initializes the identity resolver if identity config provided
- Exposes all methods for tx, signing, identity, reputation, x402

```typescript
import { Wallet, JsonRpcProvider, parseEther, formatEther } from 'ethers';
import { IdentityResolver } from './identity/resolver';
import { ReputationReporter } from './reputation/reporter';
import { X402Client } from './x402/client';
import { TTLCache } from './utils/cache';
import { getNetworkConfig } from './utils/networks';
import type { EvalancheConfig, TransactionIntent, CallIntent, AgentIdentity, FeedbackSubmission } from './types';

export class Evalanche {
  readonly wallet: Wallet;
  readonly provider: JsonRpcProvider;
  readonly address: string;
  
  private identityResolver?: IdentityResolver;
  private reputationReporter?: ReputationReporter;
  private x402Client?: X402Client;

  constructor(config: EvalancheConfig) {
    const networkConfig = getNetworkConfig(config.network ?? 'avalanche');
    this.provider = new JsonRpcProvider(networkConfig.rpcUrl);
    
    if (config.privateKey) {
      this.wallet = new Wallet(config.privateKey, this.provider);
    } else if (config.mnemonic) {
      this.wallet = Wallet.fromPhrase(config.mnemonic).connect(this.provider);
    } else {
      throw new EvalancheError('Either privateKey or mnemonic is required');
    }
    
    this.address = this.wallet.address;
    
    if (config.identity) {
      this.identityResolver = new IdentityResolver(this.provider, config.identity);
    }
    
    this.reputationReporter = new ReputationReporter(this.wallet);
    this.x402Client = new X402Client(this.wallet);
  }
  
  // ... methods as described in API above
}
```

### 2. src/identity/resolver.ts

Resolves ERC-8004 identity from on-chain registries. Same logic as the Core Extension service but standalone.

- tokenURI() → agent metadata
- getReputation() → 0-100 score
- Trust level derivation (>=75 high, >=40 medium, <40 low)
- 5-minute TTL cache

### 3. src/identity/constants.ts

```typescript
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

export const IDENTITY_ABI = [
  'function tokenURI(uint256 agentId) view returns (string)',
  'function ownerOf(uint256 agentId) view returns (address)',
];

export const REPUTATION_ABI = [
  'function getReputation(uint256 agentId) view returns (uint256)',
];

// x402 reputation extension
export const DOMAIN_SEPARATOR = 'x402:8004-reputation:v1';
```

### 4. src/wallet/transaction.ts

Transaction builder that accepts human-readable inputs:
- `value: '0.1'` → parseEther
- Auto gas estimation
- Auto nonce management
- Returns tx hash + receipt

### 5. src/x402/client.ts

x402 payment-gated HTTP client:
- Makes initial request, gets 402 Payment Required
- Parses x402 payment requirements from response headers
- Creates and signs payment
- Retries with payment proof
- Verifies response + submits reputation feedback if configured

### 6. src/reputation/reporter.ts

Submits reputation feedback on-chain after interactions:
- Creates interaction hash: `keccak256(DOMAIN_SEPARATOR || taskRef || dataHash)`
- Calls reputation contract to submit score
- Non-blocking (fire and forget with optional await)

### 7. src/utils/networks.ts

```typescript
export const NETWORKS = {
  avalanche: {
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    chainId: 43114,
    name: 'Avalanche C-Chain',
    explorer: 'https://snowtrace.io',
  },
  fuji: {
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    chainId: 43113,
    name: 'Avalanche Fuji Testnet',
    explorer: 'https://testnet.snowtrace.io',
  },
};
```

## README.md Content

Write a proper README with:
- Logo placeholder + name
- One-line description: "Agent wallet SDK for Avalanche with onchain identity (ERC-8004) and payment rails (x402)"
- Install: `npm install evalanche`
- Quick start code example
- API reference (all methods)
- Architecture diagram (text-based)
- ERC-8004 integration section
- x402 integration section
- License: MIT

## Rules

- All code in TypeScript strict mode
- ethers v6 syntax only
- No browser APIs — Node.js only (headless)
- Every public method has JSDoc comments
- Error handling: custom EvalancheError class with error codes
- All async methods return typed Promises
- Export everything from src/index.ts
- Package.json: name "evalanche", main + module + types fields
- Build with tsup: ESM + CJS dual output
- Tests with vitest, mock ethers for unit tests
- Do NOT publish to npm. Just create the package locally.

## When Done

After all files created, run:
1. `npm install` (install deps)
2. `npx tsc --noEmit` (typecheck)
3. `npx vitest run` (tests)
4. Fix any errors
5. `git add -A && git commit -m "feat: evalanche v0.1.0 — agent wallet SDK for Avalanche"`
