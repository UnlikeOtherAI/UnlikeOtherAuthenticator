import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { installFixtures } from './fixtures';

test('operator can review and append legal prepaid invoice tax policy', async ({
  page,
}, testInfo) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?section=contracts');
  const panel = page.getByRole('heading', { name: 'Prepaid invoice tax policy' })
    .locator('..').locator('..');
  await expect(panel).toContainText('pending document');
  await panel.getByLabel('Stripe account').selectOption('account-1');
  await panel.getByLabel('Legal issuer').selectOption('issuer-1');
  await panel.getByLabel('Inclusive rate (basis points)').fill('2000');
  await panel.getByLabel('Effective from (UTC)').fill('2026-10-04T00:00:00Z');
  await panel.getByLabel('Legal basis reference').fill('Verified UK VAT treatment');
  await panel.getByRole('button', { name: 'Add tax policy' }).click();
  await expect(panel).toContainText('Version 1');
  expect(fixture.taxPolicies).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  const directory = process.env.BILLING_COLLECTION_PROOF_DIR;
  const screenshot = directory
    ? path.join(directory, `issuer-tax-policy-${testInfo.project.name}.png`)
    : testInfo.outputPath('issuer-tax-policy.png');
  if (directory) await mkdir(directory, { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
});
