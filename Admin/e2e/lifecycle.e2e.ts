import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('scoped reason templates disable and reactivate each entity', async ({ page }) => {
  const fixture = await installFixtures(page);
  for (const [scope, path] of [
    ['USER', '/users/u101?tab=security'],
    ['ORGANISATION', '/organisations/o1?tab=access'],
    ['TEAM', '/organisations/o1/teams/t12?tab=access'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Disable access' })).toBeDisabled();
    await page.getByLabel('Reason template').selectOption(`reason-${scope}`);
    await expect(page.getByLabel('Reason template').locator('option')).toHaveCount(2);
    await page.getByLabel('Internal note (administrators only)').fill('Private case reference');
    await page.getByRole('button', { name: 'Disable access' }).click();
    await expect(page.getByText('Status: disabled', { exact: true })).toBeVisible();
    await expect(page.getByText('Customer reason: Access is paused while your account is reviewed.')).toBeVisible();
    await page.getByRole('button', { name: 'Reactivate access' }).click();
    await expect(page.getByText('Status: active', { exact: true })).toBeVisible();
  }
  expect(fixture.lifecycle.writes.filter((w) => w.body.status === 'DISABLED')).toHaveLength(3);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.lifecycle.unexpected).toEqual([]);
});

test('last-team preview includes empty organisation, shared accounts and evidence; failed confirmation retries safely', async ({ page }) => {
  const fixture = await installFixtures(page);
  fixture.lifecycle.failNextDelete();
  await page.goto('/organisations/o1/teams/t12?tab=access');
  await page.getByLabel('Identity handling').selectOption('ERASE_REFERENCE');
  await page.getByRole('button', { name: 'Preview deletion' }).click();
  await expect(page.getByText(/last team and its now-empty organisation/)).toBeVisible();
  await expect(page.getByText(/shared-user: account kept/)).toBeVisible();
  await expect(page.getByText(/Restricted signed evidence is retained/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm deletion' })).toBeDisabled();
  await page.getByLabel('Type DELETE t12').fill('DELETE t12');
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(page.getByRole('alert')).toContainText('RETRY_REQUIRED');
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(page.getByText(/Deletion job job-1: ready/)).toBeVisible();
  const attempts = fixture.lifecycle.writes.filter((w) => w.path.endsWith('/delete'));
  expect(attempts).toHaveLength(2);
  expect(attempts[0].body.requestKey).toEqual(attempts[1].body.requestKey);
  expect(attempts[1].body.mode).toBe('ERASE_REFERENCE');
  await expect(page).toHaveURL(/\/deletion-jobs\/job-1$/);
  await page.reload();
  await expect(page.getByText(/Deletion job job-1: ready/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish or retry deletion' }).click();
  await expect(page.getByText('Operational deletion completed. Listed protected evidence remains restricted.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivate access' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('completed-deletion.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.lifecycle.unexpected).toEqual([]);
});

test('ownership blocker prevents deletion', async ({ page }) => {
  const fixture = await installFixtures(page);
  fixture.lifecycle.blockPreview();
  await page.goto('/users/u101?tab=security');
  await page.getByRole('button', { name: 'Preview deletion' }).click();
  await page.getByLabel('Type DELETE u101').fill('DELETE u101');
  await expect(page.getByRole('alert')).toContainText('Transfer ownership');
  await expect(page.getByRole('button', { name: 'Confirm deletion' })).toBeDisabled();
  expect(fixture.lifecycle.writes.some((w) => w.path.endsWith('/delete'))).toBe(false);
});

test('reason templates save scoped customer text and increment revisions', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/access-reasons');
  await page.getByRole('button', { name: 'TEAM: Access review (revision 1, enabled)' }).click();
  await expect(page.getByLabel('Scope', { exact: true })).toBeDisabled();
  await page.getByLabel('Customer reason').fill('Your team access is temporarily paused. Contact support.');
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByRole('button', { name: 'TEAM: Access review (revision 2, enabled)' })).toBeVisible();
  expect(fixture.lifecycle.templates.find((t) => t.scope === 'TEAM')?.message).toContain('Contact support');
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('pending product purge survives reload and cannot be marked complete by the admin', async ({ page }) => {
  const fixture = await installFixtures(page);
  fixture.lifecycle.waitForProduct();
  await page.goto('/users/u101?tab=security');
  await page.getByRole('button', { name: 'Preview deletion' }).click();
  await page.getByLabel('Type DELETE u101').fill('DELETE u101');
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect(page.getByText('product.example.test: waiting for product acknowledgement')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Finish or retry deletion' })).toBeDisabled();
  expect(fixture.lifecycle.writes.some((w) => w.path.endsWith('/retry'))).toBe(false);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
