import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('operator configures product deletion from Apps', async ({ page }, info) => {
  await installFixtures(page);
  let policies: Record<string, unknown>[] = [];
  await page.route('**/internal/admin/product-erasure', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.nativeApps).toEqual(['com.example.browser']);
      expect(body.settings).toEqual(['browser/bookmarks']);
      policies = [{ ...body, revision: 1 }];
      return route.fulfill({ json: policies[0] });
    }
    return route.fulfill({ json: { policies, pending: [] } });
  });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Add product policy' }).click();
  await page.getByLabel('Product identifier', { exact: true }).fill('browser');
  await page.getByLabel('Product name', { exact: true }).fill('Example Browser');
  await page.getByLabel(/Registered native app identifiers/).fill('com.example.browser');
  await page.getByLabel(/Product-owned setting keys/).fill('browser/bookmarks');
  await page.getByLabel(/What is erased/).fill('Synced favourites are removed immediately. Browsing history stays on your device.');
  await page.getByLabel('Enable requests for this inventory').check();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByRole('link', { name: 'Deletion form' })).toHaveAttribute('href', '/auth/delete-account?product=browser');
  await page.screenshot({ path: info.outputPath('product-policies.png'), fullPage: true });
});

test('operator can preserve a workspace when its dependency review changes', async ({ page }) => {
  await installFixtures(page);
  let pending = true;
  await page.route('**/internal/admin/product-erasure', route => route.fulfill({ json: { policies: [], pending: pending ? [{
    id: 'example-job', policyId: 'studio', createdAt: '2026-11-20T09:00:00Z',
    requestedContainer: { scope: 'TEAM', name: 'Weekend' }, receipts: [],
  }] : [] } }));
  await page.route('**/internal/admin/product-erasure/example-job/container', route => {
    if (route.request().postDataJSON().decision === 'approve') return route.fulfill({ status: 409, json: { error: 'DELETION_PREVIEW_CHANGED' } });
    expect(route.request().postDataJSON().decision).toBe('preserve');
    pending = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/apps');
  await page.getByRole('button', { name: 'Review Weekend' }).click();
  await page.getByRole('button', { name: 'Confirm container deletion' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not apply the decision');
  await page.getByRole('button', { name: 'Preserve container' }).click();
  await expect(page.getByRole('heading', { name: 'Awaiting cleanup' })).toHaveCount(0);
});
