import { defineConfig } from 'vitest/config';

// Explicit server/database-free utility checks for constrained compiler slots.
// Keep the full auth harness and integration suites on vitest.config.ts.
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.light.ts'],
    include: [
      'tests/unit/native-login-failure-limit.test.ts',
      'tests/unit/login-code.service.test.ts',
      'tests/unit/profile-authority.service.test.ts',
      'tests/unit/directory-credential-authority.test.ts',
      'tests/unit/directory-owner-grants.test.ts',
      'tests/unit/directory-live-standing.test.ts',
      'tests/unit/directory-user-mutation.test.ts',
      'tests/unit/directory-lifecycle-mutation.test.ts',
      'tests/unit/client-service-audience.test.ts',
      'tests/unit/native-account-dependency-errors.test.ts',
      'tests/unit/directory-writer-coverage.test.ts',
      'tests/unit/admin-access-revocation.service.test.ts',
      'tests/unit/website-client-context.service.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
    env: { NODE_ENV: 'test', SHARED_SECRET: 'synthetic-light-test-material-32-characters',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service' },
  },
});
