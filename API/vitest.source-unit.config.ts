import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Actual workspace source, with no package build, listener or database. The
// default harness still verifies compiled package exports after slot allocation.
export default defineConfig({
  resolve: { alias: [
    { find: /^@unlikeotherai\/auth-ui-strings$/, replacement: fileURLToPath(new URL('../packages/auth-ui-strings/src/index.ts', import.meta.url)) },
    { find: /^@unlikeotherai\/slug$/, replacement: fileURLToPath(new URL('../packages/slug/src/index.ts', import.meta.url)) },
    { find: /^@unlikeotherai\/billing-statement-protocol$/, replacement: fileURLToPath(new URL('../packages/billing-statement-protocol/src/index.ts', import.meta.url)) },
  ] },
  test: {
    setupFiles: ['./tests/setup.light.ts', './tests/setup.source-network.ts'], maxWorkers: 1, fileParallelism: false,
    include: [
      'tests/unit/internal-admin.activity-stats.test.ts',
      'tests/unit/internal-admin.organisation-state.test.ts',
      'tests/unit/confidential-chained-token-exchange.service.test.ts',
      'tests/unit/confidential-delegation.service.test.ts',
      'tests/unit/client-service.test.ts',
      'tests/unit/team.service.self-join.test.ts',
      'tests/unit/auth-login.service.test.ts',
      'tests/unit/refresh-token*.test.ts',
      'tests/unit/verification-token-epoch.service.test.ts',
      'tests/unit/oauth-login.signature-gate.route.test.ts',
      'tests/unit/profile-authority.route.test.ts',
      'tests/unit/directory-authority.route.test.ts',
      'tests/unit/subject-assertion-jwks-outage.test.ts',
      'tests/unit/jwks-fetch.service.test.ts',
      'tests/unit/team-invite-link-redeem.service.test.ts',
      'tests/unit/team-invite-link.service.test.ts',
      'tests/unit/team-invite-link-admission.test.ts',
      'tests/unit/website-context-rollout.test.ts',
    ],
    env: { NODE_ENV: 'test', SHARED_SECRET: 'synthetic-source-test-material-32-characters', AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service' },
  },
});
