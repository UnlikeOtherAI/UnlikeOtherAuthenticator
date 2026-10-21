import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('operator can inspect and revoke an API-issued Voice runtime key', async ({ page }) => {
  const fixture = await installFixtures(page);
  const now = '2026-10-21T12:00:00.000Z';
  const key = { id: 'voice-key', purpose: 'voice_runtime', name: 'Telephone service',
    key_prefix: 'uoa_fixture_voice', actor_issuer: 'https://nessie.example',
    actor_audience: 'https://uoa.example/billing/v1/voice/quotes', actor_key_id: 'fixture',
    checkout_return_origins: [], last_used_at: null, expires_at: null,
    revoked_at: null as string | null, created_by_email: null, created_at: now };
  await page.route('**/internal/admin/billing/services', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify([{ id: 'nessie', name: 'Nessie', identifier: 'nessie',
      active: true, tariffs: [], assignments: [], app_keys: [key], adjustments: [],
      stripe_catalogs: [], stripe_subscriptions: [], created_at: now, updated_at: now }]),
  }));
  await page.route('**/internal/admin/billing/services/nessie/app-keys/voice-key/revoke', route => {
    key.revoked_at = now;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(key) });
  });
  await page.goto('/billing');
  await page.getByRole('link', { name: 'Nessie', exact: true }).click();
  await page.getByRole('button', { name: /App keys/ }).click();
  await expect(page.getByText('voice runtime', { exact: true })).toBeVisible();
  await expect(page.getByText('uoa_fixture_voice', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Voice call admission and settlement access');
  await page.screenshot({ path: test.info().outputPath('voice-runtime-revoke.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke Telephone service', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
