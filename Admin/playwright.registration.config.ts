import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: 'registration.flow.ts', outputDir: '../.registration-qa/playwright',
  workers: 1, retries: 0, timeout: 30000, reporter: [['list']],
  use: { channel: process.env.PW_CHANNEL, baseURL: 'http://127.0.0.1:5275', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    { command: 'pnpm --filter @uoa/auth exec vite preview --host 127.0.0.1 --port 5275 --strictPort',
      url: 'http://127.0.0.1:5275', reuseExistingServer: false },
    ...(process.env.REGISTRATION_BASE_CHECKOUT ? [{
      command: 'pnpm --filter @uoa/auth exec vite preview --host 127.0.0.1 --port 5276 --strictPort',
      cwd: process.env.REGISTRATION_BASE_CHECKOUT,
      url: 'http://127.0.0.1:5276', reuseExistingServer: false,
    }] : []),
  ],
});
