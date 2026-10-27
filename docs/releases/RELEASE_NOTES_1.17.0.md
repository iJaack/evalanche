# Evalanche v1.17.0 — Remote signer, multichain signer policy, and Solana groundwork

This release rolls up everything since v1.14.0, the last version published to npm. Versions 1.15.0, 1.16.0, and 1.17.0-rc.1 through 1.17.0-rc.7 were built and tested as release candidates for the Grok Bot box signer. They were never published to npm or tagged. v1.17.0 is the first published release after v1.14.0, so these notes cover all of them.

Local `privateKey` and `mnemonic` agents behave as in v1.14.0 apart from the items under "Compatibility changes". Every new signer capability is opt-in and off by default.

## Highlights

- Add a pluggable signer so an agent can sign without a private key in the Evalanche process. `EvalancheConfig.signer` accepts a local ethers wallet, a `SigningProvider`, or a remote signer config. `EvalancheConfig.address` starts an address-only agent that cannot sign.
- Add `evalanche-signer`, a reference signing server. It holds the key, checks a pinned Ed25519 verifier approval, recomputes the intent hash, and enforces a monotonic single-use nonce, expiry, a deny list, SpendingPolicy, token caps, and simulation. It binds to `127.0.0.1` or a unix socket and writes a hash-chained JSONL audit log. Dry-run never signs.
- Let `evalanche-mcp` run keyless with `--signer-url` / `EVALANCHE_SIGNER_URL` and `--signer-address` / `EVALANCHE_SIGNER_ADDRESS`, or read-only with `EVALANCHE_ADDRESS`. Polymarket CLI and Avalanche X/P-chain paths fail with `REMOTE_SIGNER_UNSUPPORTED` in those modes and never fall back to an environment private key.
- Add a per-chain signer policy for nineteen mainnets. Avalanche C-Chain stays on unless disabled. Every other chain, and every testnet, stays off until config enables it. Each enabled chain prices and caps itself.
- Add pinned KyberSwap and direct DEX proposer routes with Li.Fi, CoinGecko price feeds, and off-Avalanche slippage caps that fail closed. Add the Li.Fi `allowExchanges` option to the SDK and to the MCP quote, route, swap, and bridge tools.
- Add off-by-default signer modules: a Polymarket order module, an Avalanche Uniswap v3 liquidity module, CCTP V2 burn and receive, and revoke-only approvals.
- Add the Grok Bot box script `scripts/grok-bot-signer.sh` with `provision`, `start`, `stop`, `escrow`, and `restore`. State stays under the persistent home, and a nonce high-water mark below the current one is refused.
- Add offline Solana groundwork: intent and request schemas, hashes, verifier approval bytes, a strict v0 message parser, ComputeBudget binding, and typed config. Solana signing is not implemented. Every Solana request is denied and an enabled cluster fails signer startup.
- Make `npm pack` reproducible across build directories and keep the tarball under the 1,000,000-byte cap.
- Website: update the site to v1.14.0 and reflow the landing page for iPhone Duo sizes.

## Install

```sh
npm install evalanche@1.17.0
```

## Compatibility changes

- Fantom (250) and zkSync Era (324) are removed from the built-in chain list. Fantom Opera was sunset, and zkSync EraVM bytecode cannot be checked against audited EVM bytecode. Sonic (146) and HyperEVM (999) are added. Configs that name chain 250 or 324 need to change.
- Li.Fi quotes now send integrator `evalanche` with `fee` 0, so an integrator fee cannot add a FeeForwarder step.
- Simulation sends the sender as `from` on `eth_call`.
- In remote-signer and address-only modes the Polymarket paths no longer read `POLYMARKET_PRIVATE_KEY` or the wallet key.
- Slippage defaults for signer-built swaps follow the Avalanche classes: 50 bps for USDC and USDt, 200 bps for WAVAX, BTC.b, WETH.e, and sAVAX, and 300 bps for other tokens.
- New runtime dependency: `@solana/addresses` pinned at 8.5.0. The package now ships `npm-shrinkwrap.json`, the `evalanche-signer` binary, and `scripts/grok-bot-signer.sh`.

## Security

- Verifier approvals bind the full transaction, the decision, dry-run or live mode, the signer address, the chain id, and a JCS intent hash. Small-order verifier keys and non-canonical signatures are rejected, and a verifier private key on disk is refused.
- Known calldata is decoded and unknown selectors are denied. Permit, Permit2, increaseAllowance, Benqi sAVAX instant unstake, and Hyperliquid and Polymarket typed data are denied through generic signing. Li.Fi V3 and Kyber calldata are decoded leg by leg, receivers must be the treasury or an allowlisted recipient, and `minAmountOut` is enforced against the quote and the class slippage cap.
- Signer files open with `O_NOFOLLOW` and are checked up the parent chain. The key, config, and token are root-owned, and state mounts are `nosuid`, `nodev`, and `noexec`. The node binary must be root-owned. The lock helper is a pinned binary executed from its checked descriptor.
- The nonce store is created only with `--init-nonces`, then locked and fsynced. Approvals created before the store started are rejected.
- Restore refuses a missing nonce floor, a live signer, a held lock, a shorter or older audit log, symlinks inside the signer root, and special files. Escrow and restore are opt-in.
- Canonical JSON rejects sparse arrays at any depth, and the Solana schema rejects holes in program lists.
- The accepted root risk on the production box is recorded as TM-008. The signer enforces policy and is not a boundary against root.

## Signer capabilities and their defaults

| Capability | Default |
| --- | --- |
| Remote signer server and client | Opt-in. No effect on local-key agents |
| Chains other than Avalanche C-Chain | Off until enabled in config |
| Polymarket module, `buyOnly`, `revokeV1Ctf`, `unpauseUser` | Off |
| Avalanche Uniswap v3 liquidity module | Off |
| CCTP V2 burn and receive | Off |
| Revoke-only approvals | Off |
| Direct DEX venues | Off |
| Solana signing | Not implemented. Always denied |

## Solana status

This release contains no Solana signing path. `parseSolanaMessage`, `assertSolanaMessageMatchesIntent`, `resolveSolanaConfig`, and the related helpers are pure offline functions. They read no key file and make no RPC, DNS, or network request. A signing request with a `solana:` chain id is denied before any provider call, and signer startup fails when any Solana cluster is enabled. The design is in `docs/solana-support.md`.

## Upgrade notes for the Grok Bot box

Provision `evalanche-1.17.0.tgz` as a new pin and pass its published sha256. Leave older pins in place so a rollback does not overwrite them. `provision` names the pin from `package/package.json` inside the staged tarball. See `docs/deploy/grok-bot-box.md`.

## Validation and limitations

- Release gates: tests, typecheck, build, MCP export and docs parity, tarball and consumer install checks, read-only smoke, signer binary check, audit regression, and the tarball size cap. The results are attached to the GitHub release.
- The signer reset tests that use sudo, unshare, and userdel run only in CI with `EVALANCHE_DESTRUCTIVE_TESTS` set.
- `@nktkas/hyperliquid` 0.33.3 asks for Node 22.12. `npm ci` on Node 20 prints an engine warning and the pin stays.
- The 1.15.0 through 1.17.0-rc.7 notes remain in this folder as history.
