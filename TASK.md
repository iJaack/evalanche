# Evalanche v0.2.0 — Avalanche Multi-VM Integration

## Overview

Integrate `@avalabs/avalanchejs` v5 and `@avalabs/core-wallets-sdk` v3 to add native X-Chain, P-Chain support, cross-chain transfers, and P-Chain staking. Currently v0.1.0 only supports C-Chain via ethers v6.

## Dependencies to Add

```bash
npm install @avalabs/avalanchejs@^5.0.0 @avalabs/core-wallets-sdk@^3.0.2
```

Note: core-wallets-sdk has peer deps on ethers (already installed), bitcoinjs-lib, and ledger packages. We only need the Avalanche wallet parts, not Bitcoin/Ledger. Install with --legacy-peer-deps if needed.

## What to Build

### 1. src/avalanche/provider.ts — Avalanche Provider Wrapper

Wraps `@avalabs/core-wallets-sdk`'s `JsonRpcProvider` (their custom one, NOT ethers).

```typescript
import { JsonRpcProvider as AvalancheProvider, MainnetContext, FujiContext } from '@avalabs/core-wallets-sdk';
```

- `createAvalancheProvider(network: 'avalanche' | 'fuji')` → returns their JsonRpcProvider
- Expose PVMApi, AVMApi, EVMApi for chain-specific queries
- Cache the provider instance (singleton per network)

### 2. src/avalanche/signer.ts — Multi-VM Signer

Use `StaticSigner` from core-wallets-sdk for headless signing across all chains.

```typescript
import { StaticSigner } from '@avalabs/core-wallets-sdk';
```

StaticSigner is the right choice because:
- Works with a single private key for X/P and a single key for C
- No dynamic address derivation needed for agents (agents have one identity)
- Can sign X-Chain, P-Chain, and C-Chain transactions

Create:
- `createAvalancheSigner(privateKey: string | Buffer, provider: AvalancheProvider)` → StaticSigner
- Helper to derive X/P and C keys from a single private key or mnemonic

### 3. src/avalanche/xchain.ts — X-Chain Operations

X-Chain (AVM) operations using avalanchejs builders:

```typescript
import { avm } from '@avalabs/avalanchejs';
```

Methods:
- `getXBalance(address: string)` → AVAX balance on X-Chain
- `getXUTXOs(addresses: string[])` → UTXO set
- `sendX(to: string, amount: bigint, utxos, signer)` → base tx, sign, submit
- `exportFromX(amount: bigint, destination: 'P' | 'C', utxos, signer)` → export tx
- `importToX(sourceChain: 'P' | 'C', utxos, signer)` → import tx

### 4. src/avalanche/pchain.ts — P-Chain Operations + Staking

P-Chain (PVM) operations using avalanchejs Etna builders:

```typescript
import { pvm, Context } from '@avalabs/avalanchejs';
```

Methods:
- `getPBalance(address: string)` → AVAX balance on P-Chain
- `getPUTXOs(addresses: string[])` → UTXO set
- `exportFromP(amount: bigint, destination: 'X' | 'C', utxos, signer)` → export tx
- `importToP(sourceChain: 'X' | 'C', utxos, signer)` → import tx
- `addDelegator(nodeId: string, stakeAmount: bigint, startDate: bigint, endDate: bigint, rewardAddress: string, utxos, signer)` → delegation tx
- `addValidator(nodeId: string, stakeAmount: bigint, startDate: bigint, endDate: bigint, delegationFee: number, rewardAddress: string, utxos, signer)` → validation tx
- `getStake(addresses: string[])` → current staked amount
- `getCurrentValidators()` → validator list
- `getMinStake()` → min stake amounts

### 5. src/avalanche/crosschain.ts — Cross-Chain Transfer Orchestrator

High-level cross-chain transfer that handles the export→import two-step flow:

```typescript
// User-facing API
await agent.transfer({
  from: 'C',
  to: 'P',
  amount: '25',  // 25 AVAX
});
```

Implementation:
- `transfer({ from: ChainAlias, to: ChainAlias, amount: string })` → orchestrates export + wait + import
- Handles: C→X, C→P, X→C, X→P, P→C, P→X (all 6 directions)
- For C-chain exports: uses EVMUnsignedTx (different from X/P unsigned tx format)
- Waits for export tx confirmation before importing
- Returns { exportHash, importHash }

### 6. src/avalanche/index.ts — Barrel Export

Export all avalanche-specific modules.

### 7. Update src/agent.ts — Add Multi-VM Methods

Add to the Evalanche class:

```typescript
// New properties
readonly avalancheProvider?: AvalancheProvider;
readonly avalancheSigner?: StaticSigner;

// Cross-chain transfer
async transfer(opts: { from: 'X' | 'P' | 'C'; to: 'X' | 'P' | 'C'; amount: string }): Promise<TransferResult>;

// Staking
async delegate(nodeId: string, amount: string, duration: number): Promise<TransactionResult>;
async getStake(): Promise<StakeInfo>;

// Multi-chain balances
async getBalance(chain?: 'C' | 'X' | 'P'): Promise<BalanceInfo>;

// X-Chain send
async sendX(to: string, amount: string): Promise<TransactionResult>;
```

The constructor should create the AvalancheProvider and StaticSigner when a private key is provided. These are optional — if only ethers-based C-Chain is needed, they won't be initialized.

### 8. Update src/mcp/server.ts — Add New MCP Tools

Add these tools:
- `get_balance_all` — Get AVAX balance across all chains (C, X, P)
- `transfer_cross_chain` — Cross-chain transfer (C↔X↔P)
- `delegate_stake` — Delegate AVAX to a validator
- `get_stake` — Get current staking info
- `get_validators` — List current validators
- `send_x_chain` — Send AVAX on X-Chain

### 9. Update Types

New types needed:
- `ChainAlias = 'X' | 'P' | 'C'`
- `TransferResult = { exportHash: string; importHash: string }`
- `StakeInfo = { staked: string; nodeId?: string; endTime?: number }`
- `BalanceInfo = { chain: ChainAlias; balance: string; unit: string }`
- `MultiChainBalance = { C: string; X: string; P: string; total: string }`

### 10. Tests

Add tests for:
- `test/avalanche/provider.test.ts` — provider creation
- `test/avalanche/xchain.test.ts` — X-Chain operations (mocked)
- `test/avalanche/pchain.test.ts` — P-Chain operations (mocked) 
- `test/avalanche/crosschain.test.ts` — cross-chain orchestration (mocked)
- Update `test/agent.test.ts` — test new methods
- Update `test/mcp/server.test.ts` — test new tools

## Key API Details from @avalabs/avalanchejs

### Building Transactions (PVM Etna Builder)

```typescript
import { pvm, Context, utils } from '@avalabs/avalanchejs';
import { addTxSignatures } from '@avalabs/avalanchejs';

// Get context and fee state
const pvmApi = new pvm.PVMApi('https://api.avax.network');
const feeState = await pvmApi.getFeeState();

// Build add delegator tx
const unsignedTx = pvm.e.newAddPermissionlessDelegatorTx({
  feeState,
  fromAddressesBytes: [addressBytes],
  utxos: utxoSet,
  nodeId: 'NodeID-...',
  subnetId: pvm.PrimaryNetworkID.toString(), // Primary network
  stakingAssetId: context.avaxAssetID,
  weight: stakeAmount, // in nAVAX
  start: BigInt(startTimestamp),
  end: BigInt(endTimestamp),
  rewardAddresses: [rewardAddressBytes],
});

// Sign
await addTxSignatures({
  unsignedTx,
  privateKeys: [privateKeyBytes],
});

// Submit
const signedTxBytes = unsignedTx.getSignedTx().toBytes();
// Send via pvmApi.issueTx() or similar
```

### Key Utilities

```typescript
import { utils } from '@avalabs/avalanchejs';
// utils.bech32ToBytes(address) — convert bech32 to bytes
// utils.formatAddress(hrp, chain, bytes) — format bytes to bech32

import { secp256k1 } from '@avalabs/avalanchejs';  
// secp256k1.getPublicKey(privKeyBytes) — derive public key
// secp256k1.publicKeyBytesToAddress(pubKey) — derive address bytes
```

### WalletAbstract Key Methods (from core-wallets-sdk)

```typescript
// These work on StaticSigner after construction:
wallet.getAddresses('X')     // X-Chain addresses
wallet.getAddresses('P')     // P-Chain addresses  
wallet.getAddressEVM()       // C-Chain hex address
wallet.getUTXOs('X')         // Get X-Chain UTXOs
wallet.getUTXOs('P')         // Get P-Chain UTXOs
wallet.exportX(amount, utxos, 'P')  // Export from X to P
wallet.importP(utxos, 'X')          // Import to P from X
wallet.addDelegator(utxos, nodeId, amount, start, end)
wallet.addValidator(utxos, nodeId, amount, start, end, fee)
wallet.signTx(request)       // Sign any X/P/C tx
```

## Implementation Strategy

1. Install deps first
2. Build provider.ts (foundation)
3. Build signer.ts (uses provider)
4. Build xchain.ts and pchain.ts (use signer + provider)
5. Build crosschain.ts (orchestrates xchain + pchain)
6. Update agent.ts (wire everything)
7. Update MCP server
8. Write tests
9. Run typecheck + tests + build

## Rules

- Keep existing v0.1.0 functionality working (don't break C-Chain ethers flow)
- All new code in TypeScript strict mode
- JSDoc on all public methods
- Handle errors with EvalancheError + appropriate error codes
- The Avalanche multi-VM features are OPTIONAL — agent works C-Chain only if no private key for X/P derivation
- Update package.json version to 0.2.0
- Don't modify existing test files in ways that break them — ADD new tests
- ethers v6 syntax only (already enforced)
- Add new error codes to EvalancheErrorCode enum: XCHAIN_ERROR, PCHAIN_ERROR, CROSS_CHAIN_ERROR, STAKING_ERROR, UTXO_ERROR

## When Done

1. `npm install` (new deps)
2. `npx tsc --noEmit` (typecheck)
3. `npx vitest run` (all tests)
4. `npx tsup` (build)
5. Fix any errors
6. Update README.md roadmap to mark v0.2.0 items as done
7. `git add -A && git commit -m "feat: evalanche v0.2.0 — multi-VM support (X-Chain, P-Chain, cross-chain, staking)"`
