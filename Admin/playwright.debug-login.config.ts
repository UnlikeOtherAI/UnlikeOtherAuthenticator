import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'admin-debug-login.flow.ts', workers: 1, retries: 0,
  outputDir: process.env.UOA_DEBUG_EVIDENCE_DIR, reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5286', headless: true, permissions: ['clipboard-read', 'clipboard-write'] },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['Pixel 7'] } }],
  webServer: { command: 'pnpm exec vite preview --base /admin/ --host 127.0.0.1 --port 5286 --strictPort',
    url: 'http://127.0.0.1:5286/admin/login', reuseExistingServer: false },
});
