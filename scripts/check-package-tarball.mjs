#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_ROOT,
  loadPackage,
  maybeWriteJson,
  parseArgs,
  readJson,
} from './release-helpers.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_TARBALL_BYTES = 1_000_000;

function collectExportTargets(exportsField) {
  const targets = [];
  function visit(value) {
    if (!value) return;
    if (typeof value === 'string') {
      targets.push(value.replace(/^\.\//, ''));
      return;
    }
    if (typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  }
  visit(exportsField);
  return targets;
}

export async function checkPackageTarball({
  rootDir = DEFAULT_ROOT,
  packJsonFile,
  maxBytes = DEFAULT_MAX_TARBALL_BYTES,
  out,
} = {}) {
  const packJson = await readJson(path.resolve(rootDir, packJsonFile));
  const manifest = Array.isArray(packJson) ? packJson[0] : packJson;
  const tarballPath = path.resolve(path.dirname(path.resolve(rootDir, packJsonFile)), manifest.filename);
  const pkg = await loadPackage(rootDir);
  const fileSet = new Set((manifest.files ?? []).map((file) => file.path));

  const requiredPaths = [
    pkg.main?.replace(/^\.\//, ''),
    pkg.module?.replace(/^\.\//, ''),
    pkg.types?.replace(/^\.\//, ''),
    ...collectExportTargets(pkg.exports),
    'README.md',
    'package.json',
    'skill/SKILL.md',
  ].filter(Boolean);

  // Published consumers can opt into the same audited overrides as the repo.
  try {
    await fs.access(path.join(rootDir, 'security-overrides.json'));
    requiredPaths.push('security-overrides.json');
  } catch { /* Older release fixtures do not have a recipe. */ }

  const missingPaths = requiredPaths.filter((item) => !fileSet.has(item));
  let securityRecipeMatches = true;
  if (fileSet.has('security-overrides.json')) {
    const recipe = await execFileAsync('tar', ['-xOf', tarballPath, 'package/security-overrides.json'], { cwd: rootDir });
    securityRecipeMatches = JSON.stringify(JSON.parse(recipe.stdout)) === JSON.stringify(pkg.overrides ?? {});
  }

  const { stdout } = await execFileAsync('tar', ['-xOf', tarballPath, 'package/README.md'], { cwd: rootDir });
  const workspaceReadme = await fs.readFile(path.join(rootDir, 'README.md'), 'utf8');
  const readmeMatches = stdout === workspaceReadme;

  const result = {
    ok: missingPaths.length === 0 && readmeMatches && securityRecipeMatches && manifest.size <= maxBytes,
    filename: manifest.filename,
    size: manifest.size,
    unpackedSize: manifest.unpackedSize,
    entryCount: manifest.entryCount,
    maxBytes,
    readmeMatches,
    securityRecipeMatches,
    missingPaths,
  };

  if (!result.ok) {
    await maybeWriteJson(out, result);
    throw new Error('Package tarball validation failed');
  }

  return maybeWriteJson(out, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await checkPackageTarball({
    packJsonFile: args['pack-json'],
    maxBytes: args['max-bytes'] ? Number(args['max-bytes']) : DEFAULT_MAX_TARBALL_BYTES,
    out: args.out,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
