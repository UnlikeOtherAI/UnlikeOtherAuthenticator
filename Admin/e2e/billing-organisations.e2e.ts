import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { installOrganisationBillingFixtures } from './billing-organisations-fixtures';
import { installFixtures } from './fixtures';

const shots = process.env.UOA_BILLING_ORGANISATIONS_SHOTS;

async function capture(page: Page, project: string, state: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${project}-${state}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

const row = (page: Page, name: string) => page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

test('operator finds organisations by search, product and custom tariffs', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  await installOrganisationBillingFixtures(page);
  await page.goto('/billing?section=organisations');
  const acme = row(page, 'Acme Engineering');
  await expect(acme).toContainText('Nessie: Free');
  await expect(acme).toContainText('2 teams');
  await expect(row(page, 'Widgets Core')).toContainText('DeepWater: Metered plus');
  await expect(row(page, 'Acme Design')).toContainText('Product defaults');
  await noHorizontalOverflow(page);
  await capture(page, info.project.name, 'organisations-list-all');

  await page.getByRole('textbox', { name: 'Search organisations' }).fill('widgets-');
  await expect(page.getByRole('link', { name: 'Widgets Core', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acme Engineering', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search organisations' }).fill('nobody');
  await expect(page.getByText('No organisations match.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search organisations' }).fill('');

  await page.getByRole('button', { name: 'With custom tariffs', exact: true }).click();
  await expect(page).toHaveURL(/filter=custom/);
  await expect(page.getByRole('link', { name: 'Acme Design', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Widgets Core', exact: true })).toBeVisible();

  await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption({ label: 'Nessie' });
  await expect(page).toHaveURL(/product=nessie/);
  await expect(page.getByRole('link', { name: 'Widgets Core', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Organisation tariff', exact: true })).toBeVisible();
  // Tariff names are unique among Nessie's active tariffs, so the name alone identifies one.
  await expect(acme.getByRole('cell').nth(2)).toHaveText('Free');
  await expect(acme).toContainText('Backend: Standard');
  await expect(acme).toContainText('QA: Free');
  await expect(row(page, 'Widgets Core')).toContainText('Product default — Standard');
  await noHorizontalOverflow(page);
  await capture(page, info.project.name, 'organisations-list-product');

  await page.getByRole('link', { name: 'Acme Engineering', exact: true }).click();
  await expect(page).toHaveURL(/organisation=o1/);
  await expect(page).toHaveURL(/product=nessie/);
  await page.getByRole('link', { name: 'All organisations' }).click();
  await expect(page).toHaveURL(/product=nessie/);
  await expect(page).not.toHaveURL(/organisation=/);
  await expect(page.getByRole('columnheader', { name: 'Organisation tariff', exact: true })).toBeVisible();

  await page.goto('/billing?section=organisations&organisation=missing');
  await expect(page.getByText('Organisation unavailable.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'All organisations' })).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('operator moves a team, retries a refused change and removes a team tariff', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const billing = await installOrganisationBillingFixtures(page);
  await page.goto('/billing?section=organisations&organisation=o1');
  await expect(page.getByRole('heading', { name: 'Acme Engineering' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Organisation details' })).toHaveAttribute('href', /\/organisations\/o1$/);
  // DeepWater sorts first, so it is the selected tab without `product`.
  await expect(page.getByRole('button', { name: /^DeepWater/ })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: /^Nessie/ }).click();
  await expect(page.getByText(/Product default: Standard · standard v1\./)).toBeVisible();

  const frontend = page.getByRole('combobox', { name: 'Tariff for Frontend' });
  await expect(frontend.locator('option')).toHaveText([
    'Same as organisation — Free', 'Free', 'Standard',
  ]);
  await expect(page.getByRole('combobox', { name: 'Tariff for the entire organisation' }).locator('option').first())
    .toHaveText('Product default — Standard');
  await expect(page.getByRole('row').filter({ hasText: 'QA' })).toContainText(/Starts 1 \w+ \d{4}/);
  await expect(page.getByRole('row').filter({ hasText: 'Backend' })).toContainText('3.99');
  await noHorizontalOverflow(page);
  await capture(page, info.project.name, 'organisation');

  // Save and Cancel appear in a column that already has their width: nothing moves.
  const before = await frontend.boundingBox();
  await frontend.selectOption({ label: 'Standard' });
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  expect(await frontend.boundingBox()).toEqual(before);
  await expect(page.getByRole('combobox', { name: 'Tariff for Backend' })).toBeDisabled();
  await capture(page, info.project.name, 'organisation-unsaved');

  billing.refuseNextSave();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move Frontend to Standard?' });
  await expect(dialog).toContainText('Frontend uses Standard for Nessie from');
  await expect(dialog).toContainText('This month keeps its current terms.');
  // A routine move is confirmed with the primary button, not the destructive one.
  await expect(dialog.getByRole('button', { name: 'Move Frontend to Standard' })).toHaveClass(/bg-indigo-600/);
  await capture(page, info.project.name, 'organisation-confirm');
  await dialog.getByRole('button', { name: 'Move Frontend to Standard' }).click();
  const frontendRow = page.getByRole('row').filter({ hasText: 'Frontend' });
  await expect(frontendRow.getByRole('alert'))
    .toHaveText('An active Stripe subscription keeps the current tariff until it ends.');
  await expect(frontend).toHaveValue('standard');
  await capture(page, info.project.name, 'organisation-refused');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move Frontend to Standard' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(frontendRow.getByRole('alert')).toHaveCount(0);
  await expect(frontend).toHaveValue('standard');
  await expect(frontendRow).toContainText('operator@example.test');

  const backend = page.getByRole('combobox', { name: 'Tariff for Backend' });
  await backend.selectOption('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const removal = page.getByRole('dialog', { name: "Remove Backend's own tariff?" });
  await expect(removal).toContainText('(UTC) Backend uses Free.');
  await expect(removal.getByRole('button', { name: "Remove Backend's own tariff" })).toHaveClass(/bg-red-600/);
  await removal.getByRole('button', { name: "Remove Backend's own tariff" }).click();
  await expect(backend).toHaveValue('');
  await expect(page.getByRole('row').filter({ hasText: 'Backend' }).getByRole('cell').nth(3)).toHaveText('—');

  expect(billing.writes.map((write) => write.method)).toEqual(['PUT', 'PUT', 'DELETE']);
  expect(billing.writes[1]?.body).toEqual({ tariff_id: 'standard', organisation_id: 'o1', team_id: 't13' });
  await noHorizontalOverflow(page);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
