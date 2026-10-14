import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Actual workspace source, with no package build, listener or database. The
// default harness still verifies compiled package exports after slot allocation.
export default defineConfig({
  resolve: { alias: [
    { find: /^@unlikeotherai\/slug$/, replacement: fileURLToPath(new URL('../packages/slug/src/index.ts', import.meta.url)) },
    { find: /^@unlikeotherai\/billing-statement-protocol$/, replacement: fileURLToPath(new URL('../packages/billing-statement-protocol/src/index.ts', import.meta.url)) },
  ] },
  test: {
    setupFiles: ['./tests/setup.light.ts'], maxWorkers: 1, fileParallelism: false,
    include: [
      'tests/unit/internal-admin.activity-stats.test.ts',
      'tests/unit/internal-admin.organisation-state.test.ts',
      'tests/unit/confidential-chained-token-exchange.service.test.ts',
      'tests/unit/confidential-delegation.service.test.ts',
      'tests/unit/client-service.test.ts',
      'tests/unit/team.service.self-join.test.ts',
      'tests/unit/auth-login.service.test.ts',
    ],
    env: { NODE_ENV: 'test', SHARED_SECRET: 'synthetic-source-test-material-32-characters', AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service' },
  },
});
