import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    target: 'node20',
    shims: true,
    // The published tarball cap is 1_000_000 bytes. Embedded sources in the
    // maps push a single helper copy over that cap. Mappings stay. The shim
    // path is rewritten so a symlinked node_modules cannot change the bytes.
    esbuildOptions(options) {
      options.sourcesContent = false;
    },
    onSuccess: 'node scripts/normalize-shim-paths.mjs',
    // Keep Avalanche deps external — they're lazy-loaded at runtime
    external: ['@avalanche-sdk/client', '@avalanche-sdk/client/accounts', '@avalabs/avalanchejs'],
  },
  {
    entry: ['src/mcp/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    outDir: 'dist/mcp',
    // Don't bundle Avalanche-related deps — require them at runtime from node_modules
    // This avoids Ledger SDK bundling issues while keeping the file small
    external: [
      '@avalanche-sdk/client',
      '@avalanche-sdk/client/accounts',
      '@avalabs/avalanchejs',
      '@avalabs/core-chains-sdk',
      '@avalabs/glacier-sdk',
      '@avalabs/hw-app-avalanche',
      '@ledgerhq/hw-transport',
      '@ledgerhq/hw-app-eth',
      '@ledgerhq/errors',
      '@metamask/eth-sig-util',
      'ledger-bitcoin',
    ],
  },
  {
    entry: ['src/signer/cli.ts'],
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    outDir: 'dist/signer',
    onSuccess: 'node scripts/copy-flock-helper.mjs',
  },
]);
