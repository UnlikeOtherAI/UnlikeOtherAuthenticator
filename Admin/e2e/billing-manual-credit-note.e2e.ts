import { expect, test } from '@playwright/test';

import { installFixtures } from './fixtures';

test('issuer cancellation is reachable on an eligible paid invoice', async ({ page }, testInfo) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?section=contracts&contract=contract-1');
  await page.getByRole('link', { name: 'UOA-2026-000002', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'UOA-2026-000002' });
  const panel = dialog.getByRole('region', { name: 'Manual invoice credit note' });
  await expect(panel.getByText('Cancel this paid invoice')).toBeVisible();
  await panel.getByRole('button', { name: 'Prepare credit note' }).click();
  await panel.getByLabel('Cancellation reason').fill('Verified service cancellation');
  await panel.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(panel.getByText('Credit note pending issue')).toBeVisible();
  await panel.getByRole('button', { name: 'Issue legal credit note' }).click();
  await expect(panel).toContainText('CN-UOA-2026-000001');
  await expect(panel.getByRole('button', { name: 'Download credit note PDF' })).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('manual-credit-note.png'), fullPage: true });
});
