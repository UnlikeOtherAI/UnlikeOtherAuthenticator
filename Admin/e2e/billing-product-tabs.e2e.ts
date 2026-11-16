import { expect, test, type Page } from '@playwright/test';

import { billingMonthStart, nextBillingMonth } from '../src/features/admin/billing-format';
import { installFixtures } from './fixtures';

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const tab = (page: Page, label: string, count: number) =>
  page.getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) });

test('a tariff version is retired, shown on request and restored', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1');
  await expect(tab(page, 'Tariffs', 4)).toBeVisible();
  await expect(page.getByText(/A team's tariff overrides its organisation's/)).toBeVisible();
  const row = (text: string) => page.getByRole('row').filter({ hasText: text });
  await expect(row('standard v2')).toContainText('Default');
  await expect(row('standard v2')).toContainText('Everyone without their own tariff');
  await expect(row('standard v2')).toContainText('3.99 USD per seat · usage +30%, prepaid · card (Stripe)');
  await expect(row('free v1')).toContainText('3 assignments');
  await expect(row('enterprise v1')).toContainText('Active contract');
  await expect(row('standard v1')).toHaveCount(0);
  for (const blocked of ['standard v2', 'free v1', 'enterprise v1']) {
    await expect(row(blocked).getByRole('button', { name: 'Retire' })).toHaveCount(0);
  }

  await row('team v1').getByRole('button', { name: 'Retire', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Retire Team · team v1?' });
  await expect(confirmation).toContainText('Nobody can be put on this tariff any more.');
  await confirmation.getByRole('button', { name: 'Retire Team · team v1', exact: true }).click();
  await expect(row('team v1')).toHaveCount(0);
  await expect(tab(page, 'Tariffs', 3)).toBeVisible();

  await page.getByRole('checkbox', { name: 'Show retired (2)' }).click();
  await expect(page.getByRole('checkbox', { name: 'Show retired (2)' })).toBeChecked();
  await expect(page).toHaveURL(/retired=1/);
  await expect(row('team v1')).toContainText('Retired');
  await expect(row('standard v1')).toContainText(/Retired \d+ \w+ 2026/);
  await expect(row('standard v1').getByRole('button', { name: 'Set default' })).toHaveCount(0);
  await row('team v1').getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Show retired (1)' })).toBeChecked();
  await expect(row('team v1').getByRole('button', { name: 'Retire', exact: true })).toBeVisible();
  expect(fixture.tariffWrites).toEqual(['retire tariff-team-1', 'restore tariff-team-1']);
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('assignments start next month and never offer a retired tariff', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1&retired=1&tariffs_page=1&record=tariff-free-1');
  await page.getByRole('dialog').getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: /^Assignments/ }).click();
  await expect(page).toHaveURL(/\?product=billing-1&tab=assignments$/);
  const row = (text: string) => page.getByRole('row').filter({ hasText: text });
  await expect(row('Backend')).toContainText(billingMonthStart(nextBillingMonth()));
  await expect(row('Acme Design')).toContainText('—');
  await expect(row('Acme Engineering').filter({ hasText: 'Entire organisation' }))
    .toContainText('In effect');
  await expect(row('Backend').getByRole('link', { name: 'Edit' })).toHaveAttribute(
    'href', '/billing?section=organisations&organisation=o1&product=billing-1');

  await page.getByRole('button', { name: 'Assign tariff', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign tariff · Fixture product' });
  const tariff = dialog.getByRole('combobox', { name: 'Tariff version' });
  await expect(tariff).toHaveValue('tariff-standard-2');
  await expect(tariff.locator('option', { hasText: 'standard v1' })).toHaveCount(0);
  await expect(tariff.locator('option', { hasText: 'team v1' })).toHaveCount(1);
  await dialog.getByRole('textbox', { name: 'Organisation' }).fill('Design');
  await dialog.getByRole('button', { name: 'Acme Design', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Organisation' })).toHaveValue('Acme Design');
  await dialog.getByRole('button', { name: 'Close modal' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('app and Ledger keys filter active from revoked; a tab change clears paging', async ({
  page,
}) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1&tab=app-keys');
  await expect(tab(page, 'App keys', 1)).toBeVisible();
  await expect(page.getByText('Fixture production', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture staging', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoked (2)', exact: true }).click();
  await expect(page).toHaveURL(/key_status=revoked/);
  await expect(page.getByRole('row').filter({ hasText: 'Fixture staging' })).toContainText('Revoked');
  await expect(page.getByRole('row').filter({ hasText: 'Fixture preview' })).toContainText('Expired');
  await expect(page.getByText('Fixture production', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /^Ledger keys/ }).click();
  await expect(page).toHaveURL(/\?product=billing-1&tab=runtime-keys$/);
  await expect(tab(page, 'Ledger keys', 1)).toBeVisible();
  await expect(page.getByText('uoa_ledger_live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoked (1)', exact: true }).click();
  await expect(page.getByText('uoa_ledger_gone', { exact: true })).toBeVisible();
  await expect(page.getByText('uoa_ledger_live', { exact: true })).toHaveCount(0);

  await page.goto('/billing?product=billing-1&tab=subscriptions&subscriptions_page=1&record=x');
  await expect(page.getByRole('heading', { name: 'Stripe subscriptions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Seat subscriptions' })).toBeVisible();
  await expect(page.getByText('Past due', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: /^Tariffs/ }).click();
  await expect(page).toHaveURL(/\?product=billing-1&tab=tariffs$/);
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('the product list says product and shows assignment counts', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing');
  await expect(page.getByRole('button', { name: /^Products/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/Organisations use live billing by default/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add product' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Fixture product' });
  await expect(row).toContainText('Standard');
  await expect(row.locator('td').nth(3)).toHaveText('3');
  await page.getByRole('textbox', { name: 'Search billing products' }).fill('nothing');
  await expect(page.getByText('No products match this search.')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
