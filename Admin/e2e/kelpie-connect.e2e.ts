import { expect, test } from '@playwright/test';
import { installFixtures, nativeApp } from './fixtures';

test('operator can grant Kelpie connectivity through the existing app editor', async ({ page }, info) => {
  await installFixtures(page);
  const kelpie = { ...nativeApp, identifier: 'com.unlikeotherai.kelpie', name: 'Kelpie' };
  let written: unknown;
  await page.route('**/internal/admin/native-apps*', (route) => route.fulfill({ json: [kelpie] }));
  await page.route('**/internal/admin/native-apps/native-1', async (route) => {
    written = route.request().postDataJSON();
    expect(written).toMatchObject({ scopes: ['openid', 'profile', 'email', 'kelpie.connect'] });
    await route.fulfill({ json: { ...kelpie, ...written as object, revision: 2 } });
  });
  await page.goto('/apps/native-1');
  await page.getByRole('button', { name: 'Edit app', exact: true }).click();
  const scope = page.getByRole('checkbox', { name: 'kelpie.connect', exact: true });
  await expect(scope).toBeVisible(); await expect(scope).not.toBeChecked();
  await scope.check();
  await expect(page.getByText('Changing login methods, account access, return URLs or enabled status requires users to sign in again.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('kelpie-connect-consent-policy.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save app', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(written).toBeDefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unrelated native apps do not offer the Kelpie permission', async ({ page }) => {
  await installFixtures(page); await page.goto('/apps/native-1');
  await page.getByRole('button', { name: 'Edit app', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'kelpie.connect', exact: true })).toHaveCount(0);
});
