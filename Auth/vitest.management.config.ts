import { defineConfig } from 'vitest/config';

// Local headless journey only. Uses the existing public signed-config transport fixture.
export default defineConfig({ test: {
  include: ['e2e/management-browser.ui.mjs'],
  setupFiles: ['../API/tests/setup.ts'],
  hookTimeout: 180000,
  testTimeout: 60000,
} });
