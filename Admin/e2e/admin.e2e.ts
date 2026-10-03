import { expect, test, type Page } from '@playwright/test';
import { navSections } from '../src/layouts/navigation';
import { installFixtures } from './fixtures';

async function assertRendered(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/Could not load|could not be loaded|App not found|Domain not found/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('every menu destination renders at desktop and mobile sizes', async ({ page, isMobile }) => {
  const fixture = await installFixtures(page);
  await page.goto('/dashboard');
  for (const item of navSections.flatMap((section) => section.items)) {
    if (isMobile) await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.locator('aside').getByRole('link', { name: item.label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${item.path}$`));
    await assertRendered(page);
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('addressable details, subsections and legacy routes retain their content', async ({ page }) => {
  const fixture = await installFixtures(page);
  const paths = [
    '/users/u101', '/organisations/o1', '/organisations/o1/teams/t12', '/apps/native-1',
    '/domains/app.acme.com', ...['organisations', 'teams', 'users', 'access', 'credentials', 'keys', 'email', 'agreements'].map((tab) => `/domains/app.acme.com?tab=${tab}`),
    '/domains/app.acme.com?tab=agreements&agreement=agreement-1',
    '/domains/app.acme.com?tab=agreements&section=evidence', '/domains/app.acme.com?tab=agreements&section=audit',
    '/integrations?status=ALL&request=request-1', '/feature-flags/app2', '/feature-flags/app2?tab=killswitches',
    '/feature-flags/app2?tab=settings', '/feature-flags/app2/groups/new', '/billing?section=contracts',
  ];
  for (const path of paths) { await page.goto(path); await expect(page).toHaveURL(`http://127.0.0.1:5274${path}`); await assertRendered(page); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('service filters survive record navigation and browser Back; related users use canonical detail', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/domains');
  await page.getByPlaceholder('Search by service or domain...').fill('Acme');
  await expect(page.getByRole('link', { name: 'Widgets', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Acme App', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Acme App', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /View .* users/ }).click();
  await page.getByRole('link', { name: 'Alice Chen', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/u101$/);
  await page.goBack();
  await expect(page).toHaveURL(/tab=users/);
  await page.goBack();
  await page.goBack();
  await expect(page.getByPlaceholder('Search by service or domain...')).toHaveValue('Acme');
  await page.getByPlaceholder('Search by service or domain...').fill('unmatched-fixture');
  await expect(page.getByText('No services match the filters.')).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('native edits keep input after failure, persist on retry, and guard keyboard dismissal', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/apps');
  await page.getByRole('link', { name: 'Fixture Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Edit app' }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.locator('input[name="name"]');
  await name.fill('Fixture Browser renamed');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Discard unsaved changes?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  fixture.failNextNativeSave();
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await expect(dialog.getByRole('alert')).toContainText('HTTP 503');
  await expect(name).toHaveValue('Fixture Browser renamed');
  await dialog.getByRole('button', { name: 'Save app' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Fixture Browser renamed' })).toBeVisible();
  expect(fixture.nativeWrites()).toBe(2);
  await page.getByRole('button', { name: 'Edit app' }).click();
  await dialog.getByRole('button', { name: 'Close modal' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Save app' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close modal' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit app' })).toBeFocused();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
