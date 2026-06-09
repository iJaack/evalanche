## Highlights

- Retries the Polymarket release line on a fresh patch version after the `v1.10.0` npm provenance publish failed at the transparency-log step despite the GitHub release succeeding.
- Keeps the working Polymarket CLOB v2 buy path, funding fixes, and updated MCP/test coverage introduced in `v1.10.0`.
- Hardens the release workflow so a transparency-log duplicate during `npm publish --provenance` only auto-passes when the target package version is already live on npm.

## Validation

- `npm test`
- `npm run typecheck`
- `npm run build`

## Notes

- `v1.10.0` remains published as a GitHub release only: `https://github.com/iJaack/evalanche/releases/tag/v1.10.0`
- This patch release is the clean npm/publication retry for the same functional Polymarket update line: `v1.10.1`.
