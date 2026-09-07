import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runReleaseIntegrityCheck } from '../../scripts/release-integrity-check.mjs';
import { checkReleaseNotesCoverage } from '../../scripts/check-release-notes-coverage.mjs';
import { exportMcpTools } from '../../scripts/export-mcp-tools.mjs';
import { checkDocsParity } from '../../scripts/check-docs-parity.mjs';
import { checkPackageTarball } from '../../scripts/check-package-tarball.mjs';
import { checkAuditRegressions } from '../../scripts/check-audit-regressions.mjs';
import { buildReleaseManifest } from '../../scripts/build-release-manifest.mjs';
import { runReleaseSmoke } from '../../scripts/release-smoke.mjs';
import { buildReleaseSummary } from '../../scripts/build-release-summary.mjs';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evalanche-release-automation-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(root: string, file: string, content: string) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('release automation scripts', () => {
  it('validates release integrity', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'package.json', `${JSON.stringify({ name: 'evalanche', version: '1.8.8' }, null, 2)}\n`);
    await writeFixture(root, 'skill/SKILL.md', '# Skill\n');
    await writeFixture(root, 'docs/releases/RELEASE_NOTES_1.8.8.md', '## Highlights\n\n- Added release gates\n');

    const result = await runReleaseIntegrityCheck({
      rootDir: root,
      version: '1.8.8',
      tag: 'v1.8.8',
      releaseNotes: 'docs/releases/RELEASE_NOTES_1.8.8.md',
    });

    expect(result.ok).toBe(true);
    expect(result.highlightsCount).toBe(1);
  });

  it('checks release notes coverage with ignore rules', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'docs/releases/RELEASE_NOTES_1.8.8.md', '## Highlights\n\n- Added holdings registry coverage and release gates\n');
    await writeFixture(root, 'docs/releases/coverage-ignore.json', `${JSON.stringify({ ignorePrefixes: ['docs:'], ignoreCommits: [] }, null, 2)}\n`);

    const result = await checkReleaseNotesCoverage({
      rootDir: root,
      version: '1.8.8',
      previousTag: 'v1.8.7',
      currentRef: 'HEAD',
      releaseNotes: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      commits: [
        'abc123\tfeat: add holdings registry coverage',
        'def456\tdocs: refresh readme',
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.uncovered).toHaveLength(0);
  });

  it('exports MCP tools from a stubbed server module', async () => {
    const result = await exportMcpTools({
      moduleExports: {
        EvalancheMCPServer: class {
          async handleRequest() {
            return {
              result: {
                tools: [
                  { name: 'get_holdings', description: 'desc' },
                  { name: 'registry_status', description: 'desc' },
                ],
              },
            };
          }
        },
      },
    });

    expect(result.toolCount).toBe(2);
    expect(result.tools[0].name).toBe('get_holdings');
  });

  it('checks docs parity against MCP tool inventory', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'README.md', 'Use `get_holdings` and [v1.8.8](docs/releases/RELEASE_NOTES_1.8.8.md)\n');
    await writeFixture(root, 'ROADMAP.md', 'No stale notes\n');
    await writeFixture(root, 'RELEASING.md', 'docs/releases/RELEASE_NOTES_1.8.8.md\n');
    await writeFixture(root, 'SECURITY.md', '| 1.8.x   | :white_check_mark: |\n');
    await writeFixture(root, 'VULN_NOTES.md', 'No stale references\n');
    await writeFixture(root, 'mcp-tools.json', `${JSON.stringify({ tools: [{ name: 'get_holdings' }] }, null, 2)}\n`);

    const result = await checkDocsParity({
      rootDir: root,
      version: '1.8.8',
      mcpToolsFile: 'mcp-tools.json',
    });

    expect(result.ok).toBe(true);
  });

  it('validates a packed tarball against package entrypoints', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'README.md', '# Evalanche\n');
    await writeFixture(root, 'package.json', `${JSON.stringify({
      name: 'evalanche',
      version: '1.8.8',
      main: './dist/index.js',
      module: './dist/index.mjs',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.mjs',
          require: './dist/index.js',
          types: './dist/index.d.ts',
        },
      },
    }, null, 2)}\n`);

    await writeFixture(root, 'pkg/package/README.md', '# Evalanche\n');
    await writeFixture(root, 'pkg/package/dist/index.js', 'module.exports = {};');
    await writeFixture(root, 'pkg/package/dist/index.mjs', 'export {};');
    await writeFixture(root, 'pkg/package/dist/index.d.ts', 'export {};');
    await writeFixture(root, 'pkg/package/skill/SKILL.md', '# Skill\n');
    await writeFixture(root, 'pkg/package/package.json', '{}\n');

    const tarballPath = path.join(root, 'evalanche-1.8.8.tgz');
    await execFileAsync('tar', ['-czf', tarballPath, '-C', path.join(root, 'pkg'), 'package']);
    await writeFixture(root, 'pack.json', `${JSON.stringify([{
      filename: 'evalanche-1.8.8.tgz',
      size: 1000,
      unpackedSize: 2000,
      entryCount: 5,
      files: [
        { path: 'README.md' },
        { path: 'dist/index.js' },
        { path: 'dist/index.mjs' },
        { path: 'dist/index.d.ts' },
        { path: 'skill/SKILL.md' },
        { path: 'package.json' },
      ],
    }], null, 2)}\n`);

    const result = await checkPackageTarball({
      rootDir: root,
      packJsonFile: 'pack.json',
      maxBytes: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.readmeMatches).toBe(true);
  });

  it('checks audit regressions against a baseline', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'docs/security/audit-baseline.json', `${JSON.stringify({
      version: '1.8.8',
      counts: { critical: 0, high: 1, moderate: 0, low: 1, info: 0, total: 2 },
      highPackages: ['pkg-high'],
      criticalPackages: [],
      allowlistedHighPackages: [],
      allowlistedCriticalPackages: [],
    }, null, 2)}\n`);
    await writeFixture(root, 'audit.json', `${JSON.stringify({
      metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 1, info: 0, total: 2 } },
      vulnerabilities: {
        'pkg-high': { severity: 'high' },
      },
    }, null, 2)}\n`);

    const result = await checkAuditRegressions({
      rootDir: root,
      auditFile: 'audit.json',
      baselineFile: 'docs/security/audit-baseline.json',
    });

    expect(result.ok).toBe(true);
    expect(result.currentHighPackages).toEqual(['pkg-high']);
  });

  it('rejects failed audit requests and new advisories even when package counts stay constant', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'baseline.json', JSON.stringify({
      version: '1.13.0', counts: { high: 1, critical: 0 }, highPackages: ['pkg'],
      highCriticalAdvisories: ['pkg:1'],
    }));
    await writeFixture(root, 'audit.json', JSON.stringify({ error: { code: 'NETWORK_ERROR' } }));
    const options = { rootDir: root, auditFile: 'audit.json', baselineFile: 'baseline.json' };
    await expect(checkAuditRegressions(options)).rejects.toThrow('Invalid audit report');
    await writeFixture(root, 'audit.json', JSON.stringify({
      metadata: { vulnerabilities: { high: 1, critical: 0 } },
      vulnerabilities: { pkg: { severity: 'high', via: [{ name: 'pkg', source: 2, severity: 'high' }] } },
    }));
    await expect(checkAuditRegressions(options)).rejects.toThrow('new high or critical advisories');
  });

  it('builds a release manifest from workflow artifacts', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'package.json', `${JSON.stringify({ name: 'evalanche', version: '1.8.8', description: 'pkg' }, null, 2)}\n`);
    await writeFixture(root, 'docs/releases/RELEASE_NOTES_1.8.8.md', '## Highlights\n\n- Added release manifest\n');
    await writeFixture(root, 'mcp-tools.json', `${JSON.stringify({ toolCount: 10 }, null, 2)}\n`);
    await writeFixture(root, 'pack.json', `${JSON.stringify([{ filename: 'evalanche-1.8.8.tgz', size: 123, unpackedSize: 456, entryCount: 7 }], null, 2)}\n`);
    await writeFixture(root, 'tarball-check.json', `${JSON.stringify({ ok: true }, null, 2)}\n`);
    await writeFixture(root, 'audit.json', `${JSON.stringify({ metadata: { vulnerabilities: { critical: 0, high: 3, low: 18 } } }, null, 2)}\n`);
    await writeFixture(root, 'audit-regression.json', `${JSON.stringify({ ok: true }, null, 2)}\n`);
    await writeFixture(root, 'doc-refresh.json', `${JSON.stringify({ changedFiles: ['README.md'] }, null, 2)}\n`);

    const result = await buildReleaseManifest({
      rootDir: root,
      version: '1.8.8',
      tag: 'v1.8.8',
      sha: 'abc123',
      releaseNotes: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      mcpToolsFile: 'mcp-tools.json',
      packJsonFile: 'pack.json',
      tarballCheckFile: 'tarball-check.json',
      auditFile: 'audit.json',
      auditRegressionFile: 'audit-regression.json',
      docRefreshFile: 'doc-refresh.json',
    });

    expect(result.package.version).toBe('1.8.8');
    expect(result.releaseNotes.highlightsCount).toBe(1);
    expect(result.mcp.toolCount).toBe(10);
  });

  it('runs deterministic release smoke with stubbed module exports', async () => {
    const result = await runReleaseSmoke({
      moduleExports: {
        EvalancheMCPServer: class {
          async handleRequest(request: { method: string }) {
            if (request.method === 'initialize') {
              return { result: { serverInfo: { name: 'evalanche' } } };
            }
            return { result: { tools: [{ name: 'get_holdings' }] } };
          }
        },
        HoldingsClient: class {
          async scan() {
            return { holdings: [], summary: { totalHoldings: 0 } };
          }
        },
        LiFiClient: class {
          async getQuote() { return { id: 'smoke-quote' }; }
        },
        NATIVE_TOKEN: '0x0000000000000000000000000000000000000000',
        PolymarketClient: class {
          async getOrderBook() { return { bids: [{ price: 0.5 }], asks: [] }; }
        },
        HyperliquidClient: class {
          async getMarkets() { return [{ ticker: 'BTC' }]; }
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
  });

  it('builds a markdown release summary', async () => {
    const root = await makeTempDir();
    await writeFixture(root, 'integrity.json', `${JSON.stringify({ ok: true }, null, 2)}\n`);
    await writeFixture(root, 'docs-parity.json', `${JSON.stringify({ ok: true }, null, 2)}\n`);
    await writeFixture(root, 'tarball-check.json', `${JSON.stringify({ size: 123 }, null, 2)}\n`);
    await writeFixture(root, 'audit-regression.json', `${JSON.stringify({ currentCounts: { critical: 0, high: 3, low: 18 } }, null, 2)}\n`);
    await writeFixture(root, 'mcp-tools.json', `${JSON.stringify({ toolCount: 10 }, null, 2)}\n`);
    await writeFixture(root, 'smoke.json', `${JSON.stringify({ ok: true }, null, 2)}\n`);
    await writeFixture(root, 'manifest.json', `${JSON.stringify({ package: { name: 'evalanche', version: '1.8.8' } }, null, 2)}\n`);

    const markdown = await buildReleaseSummary({
      rootDir: root,
      version: '1.8.8',
      releaseNotes: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      integrityFile: 'integrity.json',
      docsParityFile: 'docs-parity.json',
      tarballCheckFile: 'tarball-check.json',
      auditRegressionFile: 'audit-regression.json',
      mcpToolsFile: 'mcp-tools.json',
      smokeFile: 'smoke.json',
      manifestFile: 'manifest.json',
      uploadedAssets: ['asset-a.json'],
    });

    expect(markdown).toContain('Release Summary: v1.8.8');
    expect(markdown).toContain('MCP tool count: 10');
  });
});
