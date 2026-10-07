import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.UOA_ADMIN_E2E_PORT ?? '5274');
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('UOA_ADMIN_E2E_PORT must be an integer from 1024 to 65535');
}
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e', testMatch: '**/*.e2e.ts', outputDir: './e2e/artifacts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']],
  use: { channel: process.env.PW_CHANNEL, baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin, reuseExistingServer: false,
    env: { VITE_ADMIN_BYPASS_AUTH: 'true', VITE_API_BASE_URL: origin },
  },
});
