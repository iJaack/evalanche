# Evalanche v1.16.0 — Per-chain signer caps

The remote signer can price and cap each chain on its own. An old Avalanche file with no `chains` object keeps the 1.15.0 effective policy.

## Highlights

- Add a per-chain signer policy for the nineteen mainnets. Avalanche 43114 stays on unless `enabled` is false or `killSwitch` is true. Every other chain stays off until `enabled` is true. Testnets cannot be enabled. An old file with no `chains` object keeps its chain list, shared token caps, gas cap, price source, and Avalanche slippage defaults.
- Price each chain from its own `price.prices` or `price.sanitySource`. The global price map is not applied once `chains` is set. An enabled chain must have a native cap, a cap for every allowlisted token, a positive `gas.maxFeeUsd`, and a native price or HTTPS feed. Address-keyed `tokenCaps` are not copied onto those chains. The native wei gas cap remains.
- Allow CTF `setApprovalForAll` to a current V2 exchange with `approved` false, and `pauseUser()` on the standard and neg-risk V2 exchanges, as kill switches. `unpauseUser` and admin `pauseTrading` stay denied.
- Stop adding the ERC-20 `transfer` selector when the Avalanche LP module is enabled. A transfer selector already in the allow map stays. The position manager is module-handled only while that module is on. A zero approve to the position manager is allowed so an allowance can be revoked. `MaxUint256` stays denied.

## Notes

Polymarket and the Avalanche Uniswap v3 LP module stay off until their own flags are set. The signer still does not call `ownerOf`. The verifier's `ownerOf` eth_call and `positions(tokenId)` pool match are built separately. See `docs/signer-multichain.md`.
