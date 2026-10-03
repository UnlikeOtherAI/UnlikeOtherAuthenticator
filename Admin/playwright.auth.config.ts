import { defineConfig, devices } from '@playwright/test';

// Reuse the workspace's browser runner to verify the separate Auth application.
export default defineConfig({
  testDir: './e2e', testMatch: 'auth-lifecycle.flow.ts', outputDir: './e2e/artifacts/auth',
  workers: 1, retries: 0, timeout: 30_000, reporter: [['list']],
  use: { channel: process.env.PW_CHANNEL, baseURL: 'http://127.0.0.1:5275', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm --filter @uoa/auth exec vite --host 127.0.0.1 --port 5275 --strictPort',
    url: 'http://127.0.0.1:5275', reuseExistingServer: false,
  },
});
