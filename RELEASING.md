# Releasing Evalanche

Evalanche uses a tag-driven GitHub Actions release workflow.

<!-- GENERATED:release-process:start -->
## Current Release Automation

- Current release line: `v1.14.0`
- Release notes path: `docs/releases/RELEASE_NOTES_1.14.0.md`
- Required workflow checks:
  - release integrity and notes coverage
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
  - docs refresh, MCP/docs parity, and README parity validation
  - package tarball and export validation
  - audit regression and read-only smoke validation
- Publish targets:
  - GitHub Release
  - GitHub Release assets
  - npm package
  - ClawHub skill
<!-- GENERATED:release-process:end -->

On every pushed `vX.Y.Z` tag, GitHub Actions will:

- validate that the tag matches `package.json`
- require `docs/releases/RELEASE_NOTES_X.Y.Z.md`
- run release integrity and release-notes coverage gates
- refresh the generated sections in release docs and push that docs commit back to `main` when needed
- run `npm test`
- run `npm run typecheck`
- run `npm run build`
- export MCP tool inventory and enforce docs parity
- validate the npm tarball contents and README parity
- enforce the audit regression gate and read-only release smoke
- create the GitHub Release from the matching notes file
- upload machine-readable release assets to the GitHub Release
- publish the npm package
- publish the ClawHub skill

## Release Steps

1. Update code, docs, and `skill/SKILL.md`.
2. Add `docs/releases/RELEASE_NOTES_X.Y.Z.md`.
3. Bump `package.json` and `package-lock.json` to `X.Y.Z` with `npm version X.Y.Z --no-git-tag-version`.
4. Run:

```bash
npm test
npm run typecheck
npm run build
```

5. Commit the release.
6. Create and push the tag:

```bash
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

## Failure Checks

- tag and `package.json` version must match exactly
- release notes file must exist in `docs/releases/`
- npm trusted publishing must still be configured
- `CLAWHUB_TOKEN` must still be valid in GitHub Actions secrets


## Consumer and live-read gates

The release installs the packed tarball in three clean temporary npm projects: plain, configured with the shipped root overrides, and configured with `--omit=optional`. Every mode must load ESM/CJS exports, boot on Avalanche by default, derive the expected wallet, sign an offline P-chain buffer, and prove the legacy Core, HPKE, and dYdX trees are absent. Every mode requires zero high/critical audit findings. Release notes must call out removed APIs and runtime-floor changes explicitly.

The shipped `security-overrides.json` must match the reviewed root overrides. The consumer gate applies that recipe at the application root in configured modes and verifies the installed tarball independently.

Both repository and consumer audit gates require complete numeric vulnerability counts, matching package severities and valid advisory records. Failed requests, missing fields or inconsistent reports block the gate; missing counts are never treated as zero.

Run the public read gate with `npm run smoke:live`. Release assets include `consumer-install-vX.Y.Z.json` and `live-reads-vX.Y.Z.json`. A failing provider check blocks publication; inspect the current HTTP result before retrying.

## Release dependency pins

GitHub Actions are pinned to verified full commit SHAs. ClawHub is pinned to `0.23.3` and uses a separate Node 22 setup; SDK validation and npm publication retain the Node 20 release runtime. Review and validate each pin update. Every release tag must be contained in `origin/main` before dependency installation or publication, even when generated docs do not change.
