import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { installOrganisationBillingFixtures } from './billing-organisations-fixtures';
import { installFixtures } from './fixtures';

const shots = process.env.UOA_BILLING_CREDIT_GRANT_SHOTS;

async function capture(page: Page, project: string, state: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${project}-${state}.png`), fullPage: true });
}

test('operator grants credits beside the tariffs, retries after a stale session and sees the grant', async ({
  page,
}, info) => {
  const fixture = await installFixtures(page);
  await installOrganisationBillingFixtures(page);
  await page.goto('/billing?section=organisations&organisation=o1');
  await expect(page.getByRole('heading', { name: 'Prepaid credits' })).toBeVisible();
  await expect(page.getByText('No credits have been granted to this organisation.')).toBeVisible();
  await capture(page, info.project.name, 'credits-empty');

  await page.getByRole('button', { name: 'Grant credits' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grant credits · Acme Engineering' });
  await expect(dialog).toContainText('Current balance: 0 credits (US$0.00)');
  await expect(dialog.getByRole('button', { name: 'Grant credits' })).toBeDisabled();
  await dialog.getByLabel('Credits to grant').fill('12.5');
  await expect(dialog).toContainText('Enter a whole number of credits within the limit.');
  await dialog.getByLabel('Credits to grant').fill('10000');
  await dialog.getByLabel('Reason').fill('Launch allowance for our own organisation');
  await expect(dialog).toContainText('Acme Engineering gets 10,000 credits (US$10.00) now, in live billing.');
  await expect(dialog).toContainText('Balance goes from 0 credits to 10,000 credits.');
  await expect(dialog).toContainText('No payment, invoice or Stripe record is created');
  await capture(page, info.project.name, 'credits-dialog');

  fixture.creditGrants.refuseNext(401, 'BILLING_CREDIT_GRANT_FRESH_SESSION_REQUIRED');
  await dialog.getByRole('button', { name: 'Grant credits' }).click();
  await expect(dialog.getByRole('alert')).toContainText('needs a session from the last five minutes');
  await expect(dialog.getByRole('button', { name: 'Sign in again' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Grant credits' }).click();
  const done = page.getByRole('dialog', { name: 'Credits granted · Acme Engineering' });
  await expect(done).toContainText('Acme Engineering received 10,000 credits (US$10.00).');
  await expect(done).toContainText('New balance: 10,000 credits (US$10.00).');
  await capture(page, info.project.name, 'credits-granted');
  await done.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('row').filter({ hasText: 'Launch allowance for our own organisation' });
  await expect(row).toContainText('10,000 credits');
  await expect(page.getByText('Spendable now').locator('..')).toContainText('10,000 credits');
  await capture(page, info.project.name, 'credits-history');

  // The retry reused the first attempt's key, so a lost response cannot grant twice.
  const [refused, granted] = fixture.creditGrants.writes;
  expect(granted?.body).toEqual({ credits: '10000', reason: 'Launch allowance for our own organisation',
    idempotency_key: refused?.body.idempotency_key });
  expect(fixture.creditGrants.writes).toHaveLength(2);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
