import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: '**/*.e2e.ts', outputDir: './e2e/artifacts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5274', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5274 --strictPort',
    url: 'http://127.0.0.1:5274', reuseExistingServer: false,
    env: { VITE_ADMIN_BYPASS_AUTH: 'true', VITE_API_BASE_URL: 'http://127.0.0.1:5274' },
  },
});
