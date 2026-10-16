# Changelog

## 1.15.0

- Add a pluggable signer so an agent can sign without a local private key in the Evalanche process.
- Add a remote signer HTTP(S) and unix-socket client. The client sends a canonical signing request and rejects a signed transaction that does not decode to the requested fields.
- Add the `evalanche-signer` reference server. It holds the key, checks an Ed25519 verifier approval, recomputes the intent hash, and enforces a monotonic single-use nonce, expiry, a deny list, SpendingPolicy, token-amount caps, and simulation. Dry-run never signs. Decisions are appended to a JSONL audit log. The default bind is `127.0.0.1` or a unix socket.
- `evalanche-mcp` accepts `--signer-url` / `EVALANCHE_SIGNER_URL` and can run keyless. `EVALANCHE_ADDRESS` is address-only mode.
- Polymarket CLI and Avalanche X/P-chain paths fail with `REMOTE_SIGNER_UNSUPPORTED` when a remote signer or address-only wallet is configured. They do not fall back to an environment private key.
- Harden the remote signer. Approvals bind the full transaction, the decision, and dry-run or live mode. Calldata checks decode known calls and deny the rest. The nonce store must be initialized, is locked and fsynced, and rejects approvals created before its start time. Message and typed-data signing are off unless allowlisted. Permit, Permit2, increaseAllowance, Benqi sAVAX instant unstake, Polymarket, and Hyperliquid typed data are denied. The audit log is a prevHash chain rooted at the SHA-256 of `evalanche-audit-root/v1`.
