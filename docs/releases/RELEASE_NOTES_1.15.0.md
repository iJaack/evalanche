# Evalanche v1.15.0 — Remote signer

An agent can run Evalanche with no private key in its process. A separate signer holds the key and signs only after an Ed25519 verifier approval.

## Highlights

- Add a pluggable signer so an agent can sign without a local private key in the Evalanche process.
- Add an HTTP(S) and unix-socket remote signer client with bearer auth, request ids, timeouts, and a check that the returned signed transaction decodes to the requested fields.
- Add `evalanche-signer`, a reference server that verifies the pinned verifier key, recomputes the intent hash from the transaction, and enforces nonce, expiry, the deny list, SpendingPolicy, token caps, and simulation.
- Fail closed, with a typed `EvalancheError`, on paths that still need raw key material: the Polymarket CLI (`POLYMARKET_PRIVATE_KEY`) and Avalanche X/P-chain / `platform-cli` signing. Read-only tools work from an address alone.

## Install

```sh
npm install evalanche@1.15.0
```

`evalanche-mcp --signer-url` (or `EVALANCHE_SIGNER_URL` plus `EVALANCHE_SIGNER_ADDRESS`) starts the MCP server without loading a key. `evalanche-signer` is the reference process that holds the key.

## What changed

- `EvalancheConfig.signer` accepts a local ethers wallet, a `SigningProvider`, or a `RemoteSignerConfig`. It is mutually exclusive with `privateKey` and `mnemonic`.
- `EvalancheConfig.address` starts an address-only agent. Signing throws `REMOTE_SIGNER_UNSUPPORTED`.
- EVM transaction, message, and EIP-712 signing, including Li.Fi swaps and bridges, vaults, staking, x402, and Hyperliquid typed data, goes through the signer. The reference server denies Hyperliquid order tools and unlimited ERC-20 approvals by default. An `approve` amount must equal the intent `amountIn`.
- Verifier approvals are `{ intentHash, nonce, expiresAt, verifier, signature }`. `canonicalIntentJson` and `computeIntentHash` build the keccak256 commitment. `routeHash` is keccak256 of the transaction data, and swap or bridge intents must include a `minAmountOut` bound.
- The signer binds to `127.0.0.1` or a unix socket, writes an append-only JSONL audit log, and can run in dry-run mode. Dry-run verifies the approval and policy, then returns without a signature.

## Migration

Local `privateKey` and `mnemonic` configs behave as before. Agents that move to a remote signer must stop passing those fields and must attach a verifier approval to each signature. Vault helpers that approve `MaxUint256` are rejected by the default signer policy.

Node.js 20 or newer is still required.
