import { defineConfig } from 'vitest/config';

// Explicit server/database-free utility checks for constrained compiler slots.
// Keep the full auth harness and integration suites on vitest.config.ts.
export default defineConfig({
  test: {
    include: [
      'tests/unit/native-login-failure-limit.test.ts',
      'tests/unit/login-code.service.test.ts',
      'tests/unit/profile-authority.service.test.ts',
      'tests/unit/directory-credential-authority.test.ts',
      'tests/unit/directory-user-mutation.test.ts',
      'tests/unit/admin-access-revocation.service.test.ts',
      'tests/unit/website-client-context.service.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
    env: { NODE_ENV: 'test', SHARED_SECRET: 'synthetic-light-test-material-32-characters',
      AUTH_SERVICE_IDENTIFIER: 'uoa-auth-service' },
  },
});
