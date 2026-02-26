import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: 'node18',
  },
  {
    entry: ['src/mcp/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    outDir: 'dist/mcp',
  },
]);
