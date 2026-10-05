import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Bound CPU contention from real wallet encryption and large SDK imports.
    maxWorkers: 2,
    // Scrypt-backed keystore checks approach five seconds on loaded CI hosts.
    testTimeout: 15_000,
  },
});
