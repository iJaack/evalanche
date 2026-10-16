# Evalanche v1.15.0 — Remote signer

An agent can run Evalanche with no private key in its process. A separate signer holds the key and signs only after an Ed25519 verifier approval.

## Highlights

- Add a pluggable signer so an agent can sign without a local private key in the Evalanche process.
- Add an HTTP(S) and unix-socket remote signer client with bearer auth, request ids, timeouts, and a check that the returned signed transaction decodes to the requested fields.
- Add `evalanche-signer`, a reference server that verifies the pinned verifier key, binds the approval to the exact transaction, and enforces an allow map, calldata checks, nonce state, expiry, SpendingPolicy, token caps, and simulation.
- Fail closed, with a typed `EvalancheError`, on paths that still need raw key material: the Polymarket CLI (`POLYMARKET_PRIVATE_KEY`) and Avalanche X/P-chain / `platform-cli` signing. Read-only tools work from an address alone.
- Harden remote signer approvals, calldata checks, and nonce state. The approval signs `evalanche-verifier/v1`, the decision, dry-run or live mode, the signer address, the chain id, and the intent hash. The intent binds the transaction object. Known calldata is decoded and unknown selectors are denied. A non-empty allow map is required. The nonce file is created only with `--init-nonces`, then locked with `flock` and fsynced.
- Bind swap legs to `tokenIn`, `amountIn`, and `tokenOut`, and cap the sold asset rather than the router. Spenders, transfer recipients, and Li.Fi `callTo` / `approveTo` must be on the allow map. Inner multicall selectors are checked the same way. Polymarket typed data, small-order verifier keys, and non-canonical signatures are denied. File checks use `O_NOFOLLOW` and cover parent directories. The default gas cap is about 0.02 native tokens, and `tx.type` must be 0 or 2.

## Install

```sh
npm install evalanche@1.15.0
```

`evalanche-mcp --signer-url` (or `EVALANCHE_SIGNER_URL` plus `EVALANCHE_SIGNER_ADDRESS`) starts the MCP server without loading a key. `evalanche-signer` is the reference process that holds the key.

## What changed

- `EvalancheConfig.signer` accepts a local ethers wallet, a `SigningProvider`, or a `RemoteSignerConfig`. It is mutually exclusive with `privateKey` and `mnemonic`.
- `EvalancheConfig.address` starts an address-only agent. Signing throws `REMOTE_SIGNER_UNSUPPORTED`.
- EVM transaction, message, and EIP-712 signing, including Li.Fi swaps and bridges, vaults, staking, x402, and Hyperliquid typed data, goes through the signer. The reference server decodes known selectors and denies the rest. A Li.Fi swap must bind its legs to the intent, and caps price the sold asset. Hyperliquid and Polymarket typed data are denied by domain and contract. An `approve` amount must equal the decoded `amountIn`, and the spender must be allowlisted. Message and typed-data signing are off unless allowlisted.
- Verifier approvals are `{ intentHash, nonce, expiresAt, verifier, signature, decision, mode, signerAddress }`. `signVerifierApproval` signs `evalanche-verifier/v1`, the decision, the mode, the signer address, the chain id, and the intent hash. Only `approve` is accepted. `routeHash` is `computeApprovedTxHash` of the transaction object. Swap or bridge intents must include a `minAmountOut` bound that the decoded call satisfies.
- The signer binds to `127.0.0.1` or a unix socket, writes an append-only JSONL audit log chained to a fixed root, and can run in dry-run mode. Dry-run consumes the nonce and returns without a signature. `--init-nonces` is required when the nonce file is missing or empty.

## Migration

Local `privateKey` and `mnemonic` configs behave as before. Agents that move to a remote signer must stop passing those fields and must attach a verifier approval to each signature. The signer config must include a non-empty `allow` map. Vault helpers that approve `MaxUint256` are rejected. Li.Fi bridge calls other than `swapTokensGeneric` and a `multicall` of decoded calls are denied until a decoder exists for them.

Node.js 20 or newer is still required.
