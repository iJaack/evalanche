#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const DOCS = {
  readme: 'README.md',
  roadmap: 'ROADMAP.md',
  releasing: 'RELEASING.md',
  security: 'SECURITY.md',
  vulnNotes: 'VULN_NOTES.md',
};

const MARKERS = {
  readme: 'release-summary',
  roadmap: 'roadmap-release',
  releasing: 'release-process',
  security: 'security-supported',
  vulnNotes: 'vuln-snapshot',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function normalizeVersion(version) {
  const value = String(version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return value;
}

function supportLine(version) {
  const [major, minor] = normalizeVersion(version).split('.');
  return {
    maintained: `${major}.${minor}.x`,
    unsupported: `< ${major}.${minor}`,
  };
}

function relativeDocLink(filePath) {
  return filePath.split(path.sep).join('/');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function extractHighlights(notes) {
  const lines = notes.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Highlights');
  if (start === -1) return [];

  const highlights = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (/^- /.test(line)) {
      highlights.push(line.replace(/^- /, '').trim());
      continue;
    }
    if (/^  - /.test(line) && highlights.length > 0) {
      const nested = line.replace(/^  - /, '').trim();
      highlights[highlights.length - 1] = `${highlights[highlights.length - 1]} ${nested}`.trim();
    }
  }
  return highlights;
}

function extractRoadmapFocusHeadings(roadmapContent) {
  return Array.from(roadmapContent.matchAll(/^###\s+(.+)$/gm)).map((match) => match[1].trim().replace(/^\d+\.\s*/, ''));
}

function buildOverridesSnapshot(overrides) {
  const entries = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'string') {
      entries.push(`- \`${key}\`: \`${value}\``);
      continue;
    }
    if (value && typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        entries.push(`- \`${key}.${nestedKey}\`: \`${nestedValue}\``);
      }
    }
  }
  return entries;
}

function formatBulletList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function replaceGeneratedSection(content, marker, replacementBody) {
  const startMarker = `<!-- GENERATED:${marker}:start -->`;
  const endMarker = `<!-- GENERATED:${marker}:end -->`;
  const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'm');
  if (!pattern.test(content)) {
    throw new Error(`Missing generated marker block: ${marker}`);
  }
  const replacement = `${startMarker}\n${replacementBody}\n${endMarker}`;
  return content.replace(pattern, replacement);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReadmeSection({ version, notesPath, highlights }) {
  const noteLink = relativeDocLink(notesPath);
  return [
    '## Current Release',
    '',
    `- Latest release: [v${version}](${noteLink})`,
    `- Published package: \`evalanche@${version}\``,
    '- Current package surface:',
    ...highlights.slice(0, 4).map((item) => `  - ${item}`),
    '- Docs:',
    '  - [Release notes](docs/releases/README.md)',
    '  - [Roadmap](ROADMAP.md)',
    '  - [Release process](RELEASING.md)',
    '  - [Security](SECURITY.md)',
  ].join('\n');
}

function buildRoadmapSection({ version, notesPath, highlights, focusHeadings }) {
  const noteLink = relativeDocLink(notesPath);
  return [
    '## Latest Shipped Release',
    '',
    `- Latest release: [v${version}](${noteLink})`,
    `- Shipped in \`v${version}\`:`,
    ...highlights.slice(0, 4).map((item) => `  - ${item}`),
    '',
    '## Current Focus',
    '',
    ...focusHeadings.map((item) => `- ${item}`),
  ].join('\n');
}

function buildReleasingSection({ version, notesPath }) {
  const notePath = relativeDocLink(notesPath);
  return [
    '## Current Release Automation',
    '',
    `- Current release line: \`v${version}\``,
    `- Release notes path: \`${notePath}\``,
    '- Required workflow checks:',
    '  - release integrity and notes coverage',
    '  - `npm test`',
    '  - `npm run typecheck`',
    '  - `npm run build`',
    '  - docs refresh, MCP/docs parity, and README parity validation',
    '  - package tarball and export validation',
    '  - audit regression and read-only smoke validation',
    '- Publish targets:',
    '  - GitHub Release',
    '  - GitHub Release assets',
    '  - npm package',
    '  - ClawHub skill',
  ].join('\n');
}

function buildSecuritySection({ version }) {
  const { maintained, unsupported } = supportLine(version);
  return [
    '## Supported Versions',
    '',
    'Security fixes are applied to the current maintained release line only.',
    '',
    '| Version | Supported |',
    '| ------- | --------- |',
    `| ${maintained}   | :white_check_mark: |`,
    `| ${unsupported}   | :x: |`,
    '',
    'For current package and release history, see:',
    '',
    '- [README](README.md)',
    '- [Release notes](docs/releases/README.md)',
    '- [Vulnerability notes](VULN_NOTES.md)',
  ].join('\n');
}

function buildVulnSection({ version, auditData, overrides }) {
  const vulnCounts = auditData?.metadata?.vulnerabilities;
  const critical = vulnCounts?.critical ?? 'unknown';
  const high = vulnCounts?.high ?? 'unknown';
  const low = vulnCounts?.low ?? 'unknown';
  const moderate = vulnCounts?.moderate ?? 'unknown';
  const overrideLines = buildOverridesSnapshot(overrides);

  return [
    '## Current Release Snapshot',
    '',
    `- Current release: \`${version}\``,
    `- \`npm audit --omit=dev\` (repository overrides): \`${critical} critical\`, \`${high} high\`, \`${moderate} moderate\`, \`${low} low\``,
    '',
    '## Active Overrides',
    '',
    ...(overrideLines.length > 0 ? overrideLines : ['- No active overrides recorded']),
  ].join('\n');
}

export async function refreshReleaseDocs({
  rootDir = DEFAULT_ROOT,
  version,
  releaseNotesPath,
  auditData,
  auditFile,
} = {}) {
  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = await readJson(pkgPath);
  const resolvedVersion = normalizeVersion(version ?? pkg.version);
  if (pkg.version !== resolvedVersion) {
    throw new Error(`Version mismatch: package.json=${pkg.version} requested=${resolvedVersion}`);
  }

  const resolvedNotesPath = releaseNotesPath
    ? path.resolve(rootDir, releaseNotesPath)
    : path.join(rootDir, 'docs', 'releases', `RELEASE_NOTES_${resolvedVersion}.md`);

  if (!path.basename(resolvedNotesPath).includes(resolvedVersion)) {
    throw new Error(`Release notes path does not match version ${resolvedVersion}: ${resolvedNotesPath}`);
  }

  const notes = await fs.readFile(resolvedNotesPath, 'utf8');
  const effectiveAuditData = auditData ?? (auditFile ? await readJson(path.resolve(rootDir, auditFile)) : null);
  const highlights = extractHighlights(notes);
  if (highlights.length === 0) {
    throw new Error(`Release notes must include a non-empty Highlights section for version ${resolvedVersion}`);
  }

  const docs = await Promise.all(
    Object.values(DOCS).map(async (file) => [file, await fs.readFile(path.join(rootDir, file), 'utf8')]),
  );
  const contentMap = new Map(docs);
  const focusHeadings = extractRoadmapFocusHeadings(contentMap.get(DOCS.roadmap) ?? '');

  const replacements = new Map([
    [DOCS.readme, buildReadmeSection({ version: resolvedVersion, notesPath: path.relative(rootDir, resolvedNotesPath), highlights })],
    [DOCS.roadmap, buildRoadmapSection({ version: resolvedVersion, notesPath: path.relative(rootDir, resolvedNotesPath), highlights, focusHeadings })],
    [DOCS.releasing, buildReleasingSection({ version: resolvedVersion, notesPath: path.relative(rootDir, resolvedNotesPath) })],
    [DOCS.security, buildSecuritySection({ version: resolvedVersion })],
    [DOCS.vulnNotes, buildVulnSection({ version: resolvedVersion, auditData: effectiveAuditData, overrides: pkg.overrides })],
  ]);

  const changedFiles = [];
  for (const [file, body] of replacements.entries()) {
    const markerKey = Object.entries(DOCS).find(([, value]) => value === file)?.[0];
    const marker = MARKERS[markerKey];
    const current = contentMap.get(file);
    if (!current) {
      throw new Error(`Missing doc content for ${file}`);
    }
    const updated = replaceGeneratedSection(current, marker, body);
    if (updated !== current) {
      await fs.writeFile(path.join(rootDir, file), updated);
      changedFiles.push(file);
    }
  }

  return {
    version: resolvedVersion,
    releaseNotesPath: relativeDocLink(path.relative(rootDir, resolvedNotesPath)),
    changedFiles,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await refreshReleaseDocs({
    version: args.version,
    releaseNotesPath: args['release-notes'],
    auditFile: args['audit-file'],
  });
  if (args.out) {
    const outPath = path.resolve(DEFAULT_ROOT, args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
