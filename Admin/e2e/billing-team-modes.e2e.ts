import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';

test('platform operator reaches team billing from the directory and billing doorway', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const org = mockAdminData.organisations[0];
  if (!org) throw new Error('Missing proof organisation');
  const team = org.teams[0];
  if (!team) throw new Error('Missing proof team');
  const proof = process.env.UOA_BILLING_MODE_PROOF_DIR;
  const phase = process.env.UOA_BILLING_MODE_PROOF_PHASE ?? 'after';
  let mode: 'live' | 'sandbox' = 'live';
  let revision = 0;
  let failNext = true;
  let failRead = false;
  const blockers: Array<{ code: string; count: number }> = [];
  const writes: unknown[] = [];
  await page.route(`**/internal/admin/billing/organisations/${org.id}/teams/${team.id}/mode`, async (route) => {
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
    return json({ mode, revision, organisation_id: org.id, team_id: team.id, blockers });
  });
  const capture = async (state: string) => {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, `${phase}-${state}-${info.project.name}.png`), fullPage: true });
  };
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fixture product', exact: true })).toBeVisible();
  await capture('billing');
  if (phase === 'before') await page.goto('/teams');
  else await page.getByRole('link', { name: 'Choose a team to manage sandbox billing' }).click();
  await page.getByRole('link', { name: team.name, exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/organisations/${org.id}/teams/${team.id}`));
  await expect(page.getByRole('heading', { name: team.name, exact: true })).toBeVisible();
  await capture('team');
  if (phase !== 'before') {
    await page.getByRole('button', { name: 'Billing', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Billing mode', exact: true })).toHaveValue('live');
    await capture('mode-live');
    await page.getByRole('combobox', { name: 'Billing mode', exact: true }).selectOption('sandbox');
    await page.getByRole('button', { name: 'Save billing mode', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not save billing mode');
    await expect(page.getByRole('combobox', { name: 'Billing mode', exact: true })).toHaveValue('sandbox');
    await capture('mode-save-error');
    await page.getByRole('button', { name: 'Save billing mode', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Billing mode saved.');
    await capture('mode-saved');
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Billing mode', exact: true })).toHaveValue('sandbox');
    await capture('mode-sandbox');
    blockers.push({ code: 'subscription', count: 1 });
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Billing mode', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save billing mode', exact: true })).toBeDisabled();
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
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
