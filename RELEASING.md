# Releasing Evalanche

Evalanche uses a tag-driven GitHub Actions release workflow.

<!-- GENERATED:release-process:start -->
## Current Release Automation

- Current release line: `v1.13.0`
- Release notes path: `docs/releases/RELEASE_NOTES_1.13.0.md`
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

The release installs the packed tarball in three clean temporary npm projects: plain, configured full, and configured `--omit=optional`. All must load ESM/CJS exports and construct an Avalanche agent. The configured full install must round-trip a dYdX order identifier. The two configured production audits must have zero high/critical findings; the plain audit is reported explicitly because upstream overrides do not propagate to consumers.

The shipped `security-overrides.json` must match the reviewed root overrides. The consumer gate uses that recipe at the application root. Keep the plain/configured distinction in release notes and audit claims. Apply the recipe as native npm root overrides; verify the installed tarball independently.

Run the public read gate with `npm run smoke:live`. Release assets include `consumer-install-vX.Y.Z.json` and `live-reads-vX.Y.Z.json`. A failing provider check blocks publication; inspect the current HTTP result before retrying.
