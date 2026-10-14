import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { installFixtures, nativeApp } from './fixtures';
import { settledScreenshot } from './audit-screenshot';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'synthetic-admin', expiresAt: Date.now() + 60000 }),
    ),
  );
  await installFixtures(page);
  await page.route('**/internal/admin/session', (route) =>
    route.fulfill({ json: { adminUser: { email: 'operator@example.test' } } }),
  );
});
test('outage recovery preserves login and expiry returns to a reachable login screen', async ({
  page,
}, info) => {
  let recovering = false;
  await page.route('**/internal/admin/session', (route) =>
    route.fulfill({
      status: recovering ? 200 : 503,
      json: { adminUser: { email: 'operator@example.test' } },
    }),
  );
  await page.goto('/dashboard');
  await expect(page.getByRole('status')).toContainText('Connecting to UOA');
  expect(await page.evaluate(() => sessionStorage.getItem('uoa-admin-session'))).not.toBeNull();
  recovering = true;
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'synthetic-admin', expiresAt: Date.now() - 1 }),
    ),
  );
  await expect(page).toHaveURL(/login/);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await settledScreenshot(page, info, 'expired-session-login.png');
});
test('icon prevalidation and upload retry never recreate or delete a native app', async ({
  page,
}, info) => {
  let created = 0,
    uploads = 0;
  const methods: string[] = [];
  await page.route('**/internal/admin/native-apps**', (route) => {
    const method = route.request().method(),
      url = new URL(route.request().url());
    if (method === 'GET') return route.fulfill({ json: created ? [nativeApp] : [] });
    methods.push(method + ' ' + url.pathname);
    if (url.pathname.endsWith('/icon'))
      return route.fulfill({ status: ++uploads === 1 ? 503 : 200, json: nativeApp });
    if (method === 'POST') created++;
    return route.fulfill({ json: nativeApp });
  });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Register app' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[name=name]').fill('Fixture Browser');
  await dialog.locator('[name=identifier]').fill('com.example.browser');
  await dialog.locator('textarea').fill('http://127.0.0.1:9000/callback');
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(270000) });
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await expect(dialog.getByRole('alert')).toContainText('smaller than 256 KB');
  expect(created).toBe(0);
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'icon.png',
    mimeType: 'image/png',
    buffer: Buffer.from('synthetic-icon'),
  });
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await expect(dialog.getByRole('alert')).toContainText('App saved. The icon could not be saved');
  await expect(dialog.locator('[name=identifier]')).toHaveAttribute('readonly', '');
  await settledScreenshot(page, info, 'native-icon-retry.png');
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await expect(dialog).toHaveCount(0);
  expect(created).toBe(1);
  expect(uploads).toBe(2);
  expect(methods).toContain('PUT /internal/admin/native-apps/native-1');
  expect(methods.some((value) => value.startsWith('DELETE'))).toBe(false);
});
test('one-time automation key reveal disappears on close and navigation', async ({
  page,
}, info) => {
  await page.route('**/internal/admin/api-keys', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'GET'
          ? []
          : {
              id: 'key-1',
              name: 'Fixture key',
              key: 'synthetic-one-time-key',
              key_prefix: 'synthetic',
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
              created_by_email: 'operator@example.test',
              created_at: '2026-10-14T12:00:00Z',
            },
    }),
  );
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByRole('dialog').locator('input').first().fill('Fixture key');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await expect(page.getByText('synthetic-one-time-key', { exact: true })).toBeVisible();
  await settledScreenshot(page, info, 'one-time-key-reveal.png');
  await page.getByRole('button', { name: 'I have copied my key' }).click();
  await expect(page.getByText('synthetic-one-time-key', { exact: true })).toHaveCount(0);
  await page.goto('/dashboard');
  await page.goto('/api-keys');
  await expect(page.getByText('synthetic-one-time-key', { exact: true })).toHaveCount(0);
});
test('protected PDF preview remains available, detaches opener, and failed/blocked previews recover', async ({
  page,
  context,
}, info) => {
  const { PDFDocument } = createRequire(resolve('..', 'API', 'package.json'))('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]);
  const bytes = Buffer.from(await pdf.save());
  const version = {
    id: 'version-1',
    version: 1,
    title: 'Terms',
    status: 'published',
    signing_method: 'click_wrap',
    source_pdf_sha256: 'a'.repeat(64),
    published_at: '2026-10-14T00:00:00Z',
    original_filename: 'terms.pdf',
    signature_count: 0,
  };
  await page.route('**/internal/admin/domains/*/signatures', (route) =>
    route.fulfill({
      json: {
        settings: { enabled: false, retention_days: 90, policy_revision: 1 },
        agreements: [
          {
            id: 'agreement-1',
            title: 'Terms',
            required_for_access: true,
            display_order: 1,
            versions: [version],
          },
        ],
        audit_events: [],
      },
    }),
  );
  let fail = false,
    reads = 0;
  await page.route('**/signatures/agreements/*/versions/*/source', async (route) => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fail
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ contentType: 'application/pdf', body: bytes });
  });
  await page.goto('/domains/app.acme.com?tab=agreements');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toMatch(/^blob:/);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(
    await page.evaluate(
      async (url) => (await (await fetch(url)).arrayBuffer()).byteLength,
      popup.url(),
    ),
  ).toBe(bytes.length);
  await settledScreenshot(page, info, 'pdf-preview-source-screen.png');
  await popup.close();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await download.failure()).toBeNull();
  fail = true;
  const failedPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const failed = await failedPromise;
  await expect.poll(() => failed.isClosed()).toBe(true);
  await expect(page.getByText(/operation could not be completed/i)).toBeVisible();
  const before = reads;
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  expect(reads).toBe(before);
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});
