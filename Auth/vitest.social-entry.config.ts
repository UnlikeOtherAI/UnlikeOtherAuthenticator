import { defineConfig } from 'vitest/config';

// Explicit local headless journey only; never part of ordinary tests or CI.
export default defineConfig({ test: {
  include: ['e2e/social-team-entry.ui.mjs'],
  setupFiles: ['../API/tests/setup.ts'],
  hookTimeout: 180000,
  testTimeout: 180000,
} });
