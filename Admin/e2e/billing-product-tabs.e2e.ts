import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { installFixtures } from './fixtures';

const shots = process.env.UOA_BILLING_PRODUCT_TABS_SHOTS;

/** Saves a picture when asked to; `focus` is scrolled into view first (the phone shows one screen). */
async function capture(page: Page, project: string, state: string, focus?: Locator) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await focus?.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, `${project}-${state}.png`), fullPage: true });
}

/** "1 December 2026": the first day of next UTC month, as the Admin names it. */
function nextMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const tab = (page: Page, label: string, count: number) =>
  page.getByRole('button', { name: new RegExp(`^${label}\\s*${count}$`) });

test('a tariff version is retired, shown on request and restored', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1');
  await expect(tab(page, 'Tariffs', 4)).toBeVisible();
  await expect(page.getByText(/A team's tariff overrides its organisation's/)).toBeVisible();
  const row = (text: string) => page.getByRole('row').filter({ hasText: text });
  await expect(row('standard v2')).toContainText('Default');
  await expect(row('standard v2')).toContainText('Everyone without their own tariff');
  await expect(row('standard v2')).toContainText('3.99 USD per seat · usage +30%, prepaid · card (Stripe)');
  await expect(row('free v1').getByRole('link', { name: '3 assignments' }))
    .toHaveAttribute('href', '/billing?product=billing-1&tab=assignments');
  await expect(row('enterprise v1')).toContainText('Active contract');
  await expect(row('standard v1')).toHaveCount(0);
  // The default is never retired; a tariff somebody is on shows Retire, disabled.
  await expect(row('standard v2').getByRole('button', { name: 'Retire' })).toHaveCount(0);
  for (const blocked of ['free v1', 'enterprise v1']) {
    await expect(row(blocked).getByRole('button', { name: 'Retire' })).toBeDisabled();
  }
  // Row actions share one line; the Default badge sits on the name's line.
  const setDefault = await row('team v1').getByRole('button', { name: 'Set default' }).boundingBox();
  const retireBox = await row('team v1').getByRole('button', { name: 'Retire' }).boundingBox();
  expect(setDefault?.y).toBe(retireBox?.y);
  const name = await row('standard v2').getByRole('link', { name: 'Standard' }).boundingBox();
  const badge = await row('standard v2').getByText('Default', { exact: true }).boundingBox();
  expect(Math.abs((name?.y ?? 0) + (name?.height ?? 0) / 2 - (badge?.y ?? 0) - (badge?.height ?? 0) / 2))
    .toBeLessThan(4);
  // Created is the date only, and leaves the table below the md breakpoint.
  await expect(page.getByRole('columnheader', { name: 'Created' }))
    .toBeVisible({ visible: info.project.name === 'desktop' });
  await capture(page, info.project.name, 'tariffs', page.getByRole('table').first());

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
  await expect(row('standard v1').getByRole('cell').nth(2)).toHaveText('Nobody');
  await capture(page, info.project.name, 'tariffs-retired', page.getByRole('table').first());
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

test('assignments start next month and never offer a retired tariff', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1&retired=1&tariffs_page=1&record=tariff-free-1');
  await page.getByRole('dialog').getByRole('button', { name: 'Close modal' }).click();
  await page.getByRole('button', { name: /^Assignments/ }).click();
  await expect(page).toHaveURL(/\?product=billing-1&tab=assignments$/);
  const row = (text: string) => page.getByRole('row').filter({ hasText: text });
  await expect(row('Backend')).toContainText(nextMonthStart());
  // No term history yet: the assignment is simply in effect.
  await expect(row('Acme Design').getByRole('cell').nth(2)).toHaveText('In effect');
  await expect(row('Acme Engineering').filter({ hasText: 'Entire organisation' }))
    .toContainText('In effect');
  await expect(row('Backend').getByRole('link', { name: 'Edit' })).toHaveAttribute(
    'href', '/billing?section=organisations&organisation=o1&product=billing-1');
  await capture(page, info.project.name, 'assignments', page.getByRole('table').first());

  await page.getByRole('button', { name: 'Assign tariff', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign tariff · Fixture product' });
  const tariff = dialog.getByRole('combobox', { name: 'Tariff version' });
  await expect(tariff).toHaveValue('tariff-standard-2');
  // Active tariffs only, each by its name: no two active tariffs share one here.
  await expect(tariff.locator('option')).toHaveText([
    'Select tariff', 'Standard · default', 'Free', 'Enterprise', 'Team',
  ]);
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
}, info) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?product=billing-1&tab=app-keys');
  await expect(tab(page, 'App keys', 1)).toBeVisible();
  await expect(page.getByText('Fixture production', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture staging', { exact: true })).toHaveCount(0);
  await capture(page, info.project.name, 'app-keys', page.getByRole('table').first());
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
  await capture(page, info.project.name, 'subscriptions', page.getByRole('heading', { name: 'Stripe subscriptions' }));
  await page.getByRole('button', { name: /^Tariffs/ }).click();
  await expect(page).toHaveURL(/\?product=billing-1&tab=tariffs$/);
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('the product list says product and shows assignment counts', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing');
  await expect(page.getByRole('button', { name: /^Products/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/Organisations use live billing by default/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add product' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Fixture product' });
  await expect(row).toContainText('Standard');
  await expect(row.locator('td').nth(3)).toHaveText('3');
  await capture(page, info.project.name, 'products', page.getByRole('table').first());
  await page.getByRole('textbox', { name: 'Search billing products' }).fill('nothing');
  await expect(page.getByText('No products match this search.')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
