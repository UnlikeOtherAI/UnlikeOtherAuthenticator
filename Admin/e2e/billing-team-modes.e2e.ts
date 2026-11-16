import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';

// The billing mode is one setting per organisation (it used to sit on each team). Billing →
// Organisations → one organisation is where an operator also reaches it.
test('platform operator reaches the organisation billing mode from Billing → Organisations', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const org = mockAdminData.organisations[0];
  if (!org) throw new Error('Missing proof organisation');
  const proof = process.env.UOA_BILLING_MODE_PROOF_DIR;
  let mode: 'live' | 'sandbox' = 'live';
  let revision = 0;
  let failNext = true;
  let failRead = false;
  const blockers: Array<{ code: string; count: number }> = [];
  const writes: unknown[] = [];
  await page.route(`**/internal/admin/billing/organisations/${org.id}/mode`, async (route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(body) });
    if (route.request().method() === 'GET' && failRead) return json({ error: 'Synthetic read failure' }, 503);
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      writes.push(input);
      if (failNext) { failNext = false; return json({ error: 'Synthetic write failure' }, 503); }
      expect(input).toEqual({ mode: 'sandbox', expected_revision: 0 });
      mode = 'sandbox'; revision = 1;
    }
    return json({ organisation_id: org.id, mode, revision, epoch: '2026-10-01T00:00:00.000Z', blockers });
  });
  const capture = async (state: string) => {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, `${state}-${info.project.name}.png`), fullPage: true });
  };
  const modeSelect = page.getByRole('combobox', { name: 'Billing mode', exact: true });
  const saveMode = page.getByRole('button', { name: 'Save billing mode', exact: true });

  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Organisations/ }).click();
  await page.getByRole('link', { name: org.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`section=organisations&organisation=${org.id}`));
  await expect(page.getByRole('heading', { name: 'Organisation billing mode', exact: true })).toBeVisible();
  await expect(modeSelect).toHaveValue('live');
  await capture('mode-live');

  await modeSelect.selectOption('sandbox');
  await saveMode.click();
  await expect(page.getByRole('alert')).toContainText('Could not save billing mode');
  await expect(modeSelect).toHaveValue('sandbox');
  await capture('mode-save-error');
  await saveMode.click();
  await expect(page.getByRole('status')).toContainText('Billing mode saved.');
  await capture('mode-saved');
  await page.reload();
  await expect(modeSelect).toHaveValue('sandbox');

  blockers.push({ code: 'subscription', count: 1 });
  await page.reload();
  await expect(modeSelect).toBeDisabled();
  await expect(saveMode).toBeDisabled();
  await expect(page.getByText('Active subscription (1)', { exact: true })).toBeVisible();
  await capture('mode-blocked');

  failRead = true;
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Could not load billing mode', { timeout: 15000 });
  await capture('mode-load-error');
  failRead = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Active subscription (1)', { exact: true })).toBeVisible();

  expect(writes).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
