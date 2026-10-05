#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(__dirname, '..');

export function parseArgs(argv) {
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

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function normalizeVersion(version) {
  const value = String(version ?? '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return value;
}

export function releaseNotesPath(rootDir, version) {
  return path.join(rootDir, 'docs', 'releases', `RELEASE_NOTES_${normalizeVersion(version)}.md`);
}

export function extractHighlights(notes) {
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

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[`*_()[\]{}#:.!,/\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'to', 'of', 'on', 'in', 'with', 'from', 'into',
  'add', 'added', 'adds', 'fix', 'fixed', 'fixes', 'update', 'updated', 'updates',
  'release', 'docs', 'doc', 'chore', 'ci', 'refactor', 'refactors', 'automation',
  'automate', 'workflow', 'workflows',
]);

export function subjectCoverageTokens(subject) {
  const cleaned = subject.replace(/^[a-z0-9_-]+:\s*/i, '');
  return Array.from(new Set(
    normalizeText(cleaned)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  ));
}

export function isCommitCoveredByNotes(subject, notesText) {
  const normalizedNotes = normalizeText(notesText);
  const tokens = subjectCoverageTokens(subject);
  if (tokens.length === 0) return true;
  return tokens.every((token) => normalizedNotes.includes(token));
}

export async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export async function gitLines(cwd, ...args) {
  const output = await git(cwd, ...args);
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

export async function loadPackage(rootDir = DEFAULT_ROOT) {
  return readJson(path.join(rootDir, 'package.json'));
}

export function supportLine(version) {
  const [major, minor] = normalizeVersion(version).split('.');
  return {
    current: `${major}.${minor}.x`,
    previous: `< ${major}.${minor}`,
  };
}

export function latestAuditSummary(auditData) {
  const vulnCounts = auditData?.metadata?.vulnerabilities;
  const entries = auditData?.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  if (auditData?.error || !vulnCounts || !entries || typeof entries !== 'object' || Array.isArray(entries) ||
      [...severities, 'total'].some((key) => !Number.isSafeInteger(vulnCounts[key]) || vulnCounts[key] < 0) ||
      severities.reduce((sum, key) => sum + vulnCounts[key], 0) !== vulnCounts.total ||
      Object.values(entries).some((entry) => !entry || !severities.includes(entry.severity) ||
        (entry.via !== undefined && (!Array.isArray(entry.via) || entry.via.some((via) =>
          typeof via !== 'string' && (!via || !severities.includes(via.severity) ||
            typeof via.name !== 'string' || !via.name || !Number.isSafeInteger(via.source)))))) ||
      severities.some((severity) => Object.values(entries).filter((entry) => entry.severity === severity).length !== vulnCounts[severity])) {
    throw new Error('Invalid audit report: audit request failed or vulnerability data is incomplete or malformed');
  }
  return Object.fromEntries([...severities, 'total'].map((key) => [key, vulnCounts[key]]));
}

export function packagesBySeverity(auditData, severity) {
  return Object.entries(auditData?.vulnerabilities ?? {})
    .filter(([, details]) => details?.severity === severity)
    .map(([name]) => name)
    .sort();
}

export async function maybeWriteJson(outPath, data) {
  if (outPath) await writeJson(outPath, data);
  return data;
}
