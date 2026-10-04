import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { installFixtures } from './fixtures';

test('platform operator reviews exact over-bound receipt and records a capped waiver', async ({
  page,
}, testInfo) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?section=exceptions');
  const panel = page.getByRole('heading', { name: 'Paid usage exceptions' })
    .locator('..').locator('..');
  await expect(panel).toContainText('dispatch-overbound-1');
  await expect(panel).toContainText('le_dispatch-overbound-1');
  await expect(panel).toContainText('Maximum collectible 200 microcredits');
  const directory = process.env.BILLING_RENEWAL_PROOF_DIR;
  const screenshot = directory
    ? path.join(directory, `paid-usage-exception-${testInfo.project.name}.png`)
    : testInfo.outputPath('paid-usage-exception.png');
  if (directory) await mkdir(directory, { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  await panel.getByRole('button', { name: 'Review waiver' }).click();
  await expect(panel).toContainText('a'.repeat(64));
  await panel.getByLabel('Operator reason').fill('Provider exceeded its original authorized cost bound.');
  await panel.getByRole('button', { name: 'Cap charge and waive excess' }).click();
  await expect(panel).toContainText('No over-bound paid usage needs a decision.');
  expect(fixture.paidUsageDecisions).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
});
