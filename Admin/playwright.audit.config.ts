import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: './e2e/artifacts/audit',
  reporter: [['list']],
  use: { channel: 'chromium', headless: true, trace: 'retain-on-failure' },
  projects: ['desktop', 'mobile'].flatMap((name) => [
    {
      name: name + '-auth',
      testMatch: 'audit-auth.flow.ts',
      use: {
        ...(name === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
        baseURL: 'http://127.0.0.1:5292',
      },
    },
    {
      name: name + '-admin',
      testMatch: ['audit-admin.flow.ts', 'audit-lifecycle.flow.ts'],
      use: {
        ...(name === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
        baseURL: 'http://127.0.0.1:5291',
      },
    },
  ]),
  webServer: [
    {
      command: 'pnpm --filter @uoa/auth exec vite --host 127.0.0.1 --port 5292 --strictPort',
      url: 'http://127.0.0.1:5292',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm exec vite --host 127.0.0.1 --port 5291 --strictPort',
      url: 'http://127.0.0.1:5291',
      reuseExistingServer: false,
      env: { VITE_ADMIN_BYPASS_AUTH: 'false', VITE_API_BASE_URL: 'http://127.0.0.1:5291' },
    },
  ],
});
