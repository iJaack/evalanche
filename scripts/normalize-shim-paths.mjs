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
    const next = text.replace(/[^\s"'()]*node_modules\/tsup\/assets\//g, 'tsup/assets/');
    if (next !== text) writeFileSync(path, next);
  }
}

walk(root);
