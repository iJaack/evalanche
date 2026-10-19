/**
 * esbuild names tsup's CJS/ESM shim by its real path. A node_modules
 * symlink outside the package changes that path and the pack bytes.
 * Rewrite every such path to the stable suffix `tsup/assets/`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(js|mjs|cjs|map)$/.test(name)) continue;
    const text = readFileSync(path, 'utf8');
    const next = rewriteShimPaths(text);
    if (next !== text) writeFileSync(path, next);
  }
}

const NEEDLE = 'node_modules/tsup/assets/';

/** Linear rewrite. A regex over a one-line sourcemap backtracks. */
function rewriteShimPaths(text) {
  if (!text.includes(NEEDLE)) return text;
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(NEEDLE, cursor);
    if (at === -1) {
      out += text.slice(cursor);
      break;
    }
    let start = at;
    while (start > cursor) {
      const char = text[start - 1];
      if (char === ' ' || char === '\n' || char === '\t' || char === '"' || char === "'" || char === '(' || char === ')') break;
      start -= 1;
    }
    out += text.slice(cursor, start);
    out += 'tsup/assets/';
    cursor = at + NEEDLE.length;
  }
  return out;
}

walk(root);
