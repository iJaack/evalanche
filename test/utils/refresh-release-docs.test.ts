import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshReleaseDocs } from '../../scripts/refresh-release-docs.mjs';

const tempDirs: string[] = [];

async function makeFixture({
  version = '1.8.8',
  includeMarkers = true,
}: {
  version?: string;
  includeMarkers?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evalanche-release-docs-'));
  tempDirs.push(root);

  await fs.mkdir(path.join(root, 'docs', 'releases'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      name: 'evalanche',
      version,
      description: 'Test package',
      overrides: {
        axios: '1.13.6',
        '@hpke/core': '^1.9.0',
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, 'docs', 'releases', `RELEASE_NOTES_${version}.md`),
    `## Highlights\n\n- Added deterministic docs refresh\n- Added workflow parity checks\n`,
  );

  const readmeBlock = includeMarkers
    ? '<!-- GENERATED:release-summary:start -->\nold\n<!-- GENERATED:release-summary:end -->'
    : 'no markers';
  const roadmapBlock = includeMarkers
    ? '<!-- GENERATED:roadmap-release:start -->\nold\n<!-- GENERATED:roadmap-release:end -->'
    : 'no markers';
  const releasingBlock = includeMarkers
    ? '<!-- GENERATED:release-process:start -->\nold\n<!-- GENERATED:release-process:end -->'
    : 'no markers';
  const securityBlock = includeMarkers
    ? '<!-- GENERATED:security-supported:start -->\nold\n<!-- GENERATED:security-supported:end -->'
    : 'no markers';
  const vulnBlock = includeMarkers
    ? '<!-- GENERATED:vuln-snapshot:start -->\nold\n<!-- GENERATED:vuln-snapshot:end -->'
    : 'no markers';

  await fs.writeFile(path.join(root, 'README.md'), `# README\n\nstatic intro\n\n${readmeBlock}\n\nstatic outro\n`);
  await fs.writeFile(
    path.join(root, 'ROADMAP.md'),
    `# Roadmap\n\n${roadmapBlock}\n\n## Near-Term Priorities\n\n### First focus\n### Second focus\n`,
  );
  await fs.writeFile(path.join(root, 'RELEASING.md'), `# Releasing\n\n${releasingBlock}\n`);
  await fs.writeFile(path.join(root, 'SECURITY.md'), `# Security\n\n${securityBlock}\n`);
  await fs.writeFile(path.join(root, 'VULN_NOTES.md'), `# Vuln\n\n${vulnBlock}\n`);

  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('refreshReleaseDocs', () => {
  it('rewrites only marker-bounded sections and preserves static text', async () => {
    const root = await makeFixture();

    const result = await refreshReleaseDocs({
      rootDir: root,
      version: '1.8.8',
      releaseNotesPath: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      auditData: {
        metadata: {
          vulnerabilities: {
            critical: 0,
            high: 3,
            low: 18,
          },
        },
      },
    });

    expect(result.changedFiles).toEqual([
      'README.md',
      'ROADMAP.md',
      'RELEASING.md',
      'SECURITY.md',
      'VULN_NOTES.md',
    ]);

    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const roadmap = await fs.readFile(path.join(root, 'ROADMAP.md'), 'utf8');
    const security = await fs.readFile(path.join(root, 'SECURITY.md'), 'utf8');
    const vulnNotes = await fs.readFile(path.join(root, 'VULN_NOTES.md'), 'utf8');

    expect(readme).toContain('static intro');
    expect(readme).toContain('Latest release: [v1.8.8]');
    expect(roadmap).toContain('- First focus');
    expect(roadmap).toContain('- Second focus');
    expect(security).toContain('| 1.8.x   | :white_check_mark: |');
    expect(vulnNotes).toContain('`0 critical`, `3 high`');
    expect(vulnNotes).toContain('`18 low`');
    expect(vulnNotes).toContain('(repository overrides)');
  });

  it('is deterministic and no-ops on the second run', async () => {
    const root = await makeFixture();
    const auditData = {
      metadata: {
        vulnerabilities: {
          critical: 0,
          high: 3,
          low: 18,
        },
      },
    };

    const first = await refreshReleaseDocs({
      rootDir: root,
      version: '1.8.8',
      releaseNotesPath: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      auditData,
    });
    const second = await refreshReleaseDocs({
      rootDir: root,
      version: '1.8.8',
      releaseNotesPath: 'docs/releases/RELEASE_NOTES_1.8.8.md',
      auditData,
    });

    expect(first.changedFiles.length).toBeGreaterThan(0);
    expect(second.changedFiles).toEqual([]);
  });

  it('fails when a generated marker block is missing', async () => {
    const root = await makeFixture({ includeMarkers: false });

    await expect(refreshReleaseDocs({
      rootDir: root,
      version: '1.8.8',
      releaseNotesPath: 'docs/releases/RELEASE_NOTES_1.8.8.md',
    })).rejects.toThrow('Missing generated marker block');
  });

  it('fails on version mismatch', async () => {
    const root = await makeFixture({ version: '1.8.7' });

    await expect(refreshReleaseDocs({
      rootDir: root,
      version: '1.8.8',
      releaseNotesPath: 'docs/releases/RELEASE_NOTES_1.8.8.md',
    })).rejects.toThrow('Version mismatch');
  });
});
