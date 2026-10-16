import { expect, test } from '@playwright/test';

import { installFixtures } from './fixtures';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';

test('operator grants, revokes and retries the exact user permission', async ({ page }) => {
  const fixtures = await installFixtures(page);
  let allowed = false;
  let failNext = false;
  const decisions: boolean[] = [];
  await page.route('**/internal/admin/users/u101', async (route) => {
    const user = mockAdminData.users.find((entry) => entry.id === 'u101');
    await route.fulfill({ json: { ...user, deeptestNessieInferenceAllowed: allowed } });
  });
  await page.route('**/internal/admin/users/u101/deeptest-nessie-inference', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    const body = route.request().postDataJSON() as { allowed: boolean };
    expect(Object.keys(body)).toEqual(['allowed']);
    decisions.push(body.allowed);
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { error: 'Request failed' } });
    }
    allowed = body.allowed;
    return route.fulfill({ json: { allowed } });
  });

  await page.goto('/users/u101?tab=security');
  const permission = page.getByRole('checkbox', { name: 'Allow Nessie executor inference' });
  await expect(permission).not.toBeChecked();
  await permission.check();
  await expect(permission).toBeChecked();
  await page.reload();
  await expect(permission).toBeChecked();
  failNext = true;
  await permission.uncheck();
  await expect(page.getByRole('alert')).toContainText('The permission could not be saved');
  await expect(permission).toBeChecked();
  await permission.uncheck();
  await expect(permission).not.toBeChecked();
  await page.reload();
  await expect(permission).not.toBeChecked();
  await permission.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('deeptest-permission.png'), fullPage: true });
  expect(decisions).toEqual([true, false, false]);
  expect(fixtures.errors).toEqual([]);
  expect(fixtures.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
