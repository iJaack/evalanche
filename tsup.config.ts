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
    // Keep Avalanche deps external — they're lazy-loaded at runtime
    external: ['@avalabs/core-wallets-sdk', '@avalabs/avalanchejs'],
  },
  {
    entry: ['src/mcp/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: true,
    sourcemap: false,
    clean: false,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    outDir: 'dist/mcp',
    // Don't bundle anything — use node_modules at runtime
    // This ensures @avalabs/core-wallets-sdk is only loaded when multi-VM is used
    noBundle: true,
  },
]);
