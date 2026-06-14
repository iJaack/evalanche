## Highlights

- Replaces the Polymarket SDK execution path with the official `polymarket` CLI for authenticated venue operations.
- Routes the MCP Polymarket wallet tools through a hardened CLI adapter that uses `execFile`, forces JSON output, avoids argv secrets, redacts signer material, and fails closed on malformed CLI output.
- Removes `@polymarket/clob-client`, `@polymarket/clob-client-v2`, and the local Polymarket client type shim from the package dependency surface.
- Removes hidden raw/diagnostic Polymarket write paths so production agents use the advertised preflight, execution, and reconciliation tools.

## Validation

- `npm run test -- test/polymarket/cli.test.ts test/polymarket/client.test.ts test/polymarket/client-extended.test.ts test/mcp/server.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run test -- test/economy/simulation.test.ts test/economy/policies.test.ts test/mcp/server.test.ts test/polymarket/client-extended.test.ts`
- `python3 polymarket/pm_calibration.py report` in the Mony workspace, read-only
- `openclaw agent --agent mony --local --json --timeout 180`, read-only no-trade prompt

## Notes

- The official `polymarket` binary must be installed in production or configured with `EVALANCHE_POLYMARKET_CLI_BIN`; local tests mock the subprocess runner because the binary is not vendored by Evalanche.
- The OpenClaw/Mony runtime check was intentionally read-only. Mony's existing local wrappers still need to move off direct Polymarket SDK usage before a funded production wallet dry-run is appropriate.
- This minor release supersedes the `v1.10.x` Polymarket SDK release line with the official CLI path: `v1.11.0`.
