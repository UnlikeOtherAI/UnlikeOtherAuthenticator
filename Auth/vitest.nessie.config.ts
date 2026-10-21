import { defineConfig } from 'vitest/config';

// Explicit local two-application browser evaluation; excluded from ordinary tests and CI.
export default defineConfig({ test: {
  include: ['e2e/nessie-sso.ui.mjs'],
  setupFiles: ['../API/tests/setup.ts'],
  hookTimeout: 180000,
  testTimeout: 180000,
} });
