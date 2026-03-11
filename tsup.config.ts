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
    // Keep Avalanche deps + native modules external — resolved at runtime
    external: ['@avalabs/core-wallets-sdk', '@avalabs/avalanchejs', 'better-sqlite3'],
  },
  {
    entry: ['src/mcp/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: true,
    sourcemap: false,
    clean: false,
    target: 'node18',
    outDir: 'dist/mcp',
    // Keep all node_modules external — resolved at runtime
    external: [/^[^./]/],
  },
  {
    entry: ['src/marketplace/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    target: 'node18',
    outDir: 'dist/marketplace',
    // better-sqlite3 is a native CJS module — must stay external
    external: [/^[^./]/],
  },
]);
