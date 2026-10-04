import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { navSections } from '../src/layouts/navigation';
import { installFixtures } from './fixtures';

async function assertRendered(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.getByText(/Could not load|could not be loaded|App not found|Domain not found/),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
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

test('addressable details, subsections and legacy routes retain their content', async ({
  page,
}) => {
  const fixture = await installFixtures(page);
  test.setTimeout(90_000);
  const paths = [
    '/users/u101',
    '/organisations/o1',
    '/organisations/o1/teams/t12',
    '/apps/native-1',
    '/domains/app.acme.com',
    ...[
      'organisations',
      'teams',
      'users',
      'access',
      'credentials',
      'keys',
      'email',
      'agreements',
    ].map((tab) => `/domains/app.acme.com?tab=${tab}`),
    '/domains/app.acme.com?tab=agreements&agreement=agreement-1',
    '/domains/app.acme.com?tab=agreements&section=evidence',
    '/domains/app.acme.com?tab=agreements&section=audit',
    '/integrations?status=ALL&request=request-1',
    '/feature-flags/app2',
    '/feature-flags/app2?tab=killswitches',
    '/feature-flags/app2?tab=settings',
    '/feature-flags/app2/groups/new',
    '/billing?section=contracts',
  ];
  for (const path of paths) {
    await page.goto(path);
    await expect(page).toHaveURL(`http://127.0.0.1:5274${path}`);
    await assertRendered(page);
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('service filters survive record navigation and browser Back; related users use canonical detail', async ({
  page,
}) => {
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

test('native edits keep input after failure, persist on retry, and guard keyboard dismissal', async ({
  page, isMobile,
}, testInfo) => {
  const fixture = await installFixtures(page);
  await page.goto('/apps?q=Fixture');
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
  const logo = page.locator('aside img[alt="UOA"]');
  const logoMetrics = await logo.evaluate(async (element) => {
    const img = element as HTMLImageElement;
    await img.decode();
    const rect = img.getBoundingClientRect();
    const parent = img.parentElement?.getBoundingClientRect();
    return { complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      width: rect.width, height: rect.height, x: rect.x, y: rect.y,
      parentHeight: parent?.height, parentY: parent?.y, source: img.currentSrc };
  });
  expect(logoMetrics.complete).toBe(true);
  expect(logoMetrics.naturalWidth).toBeGreaterThan(0);
  expect(logoMetrics.width).toBe(56);
  expect(logoMetrics.height).toBe(56);
  await testInfo.attach('decoded-logo-metrics', { body: JSON.stringify(logoMetrics, null, 2), contentType: 'application/json' });
  console.log(testInfo.project.name, 'decoded logo', JSON.stringify(logoMetrics));
  await page.screenshot({ path: testInfo.outputPath('native-detail.png'), fullPage: true });
  if (isMobile) {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(logo).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('native-navigation.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close navigation' }).click({ position: { x: 350, y: 100 } });
  }

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
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5274/apps?q=Fixture');
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('activity filters, CSV export and excluded selections stay in sync', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/logs?selected=l1');
  await expect(page.getByRole('heading', { name: 'Login event' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('alice');
  await page.getByRole('combobox', { name: 'Method', exact: true }).selectOption('google');
  await page.getByLabel('From (UTC)', { exact: true }).fill('2026-04-07');
  await page.getByLabel('To (UTC)', { exact: true }).fill('2026-04-07');
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('login-activity.csv');
  const file = await download.path();
  const csv = await readFile(file, 'utf8');
  expect(csv).toContain('alice@acme.com');
  expect(csv).not.toContain('bob@widgets.io');
  expect(csv.trim().split('\r\n')).toHaveLength(2);
  await page.getByRole('searchbox', { name: 'Search activity' }).fill('unmatched-event');
  await expect(page.getByRole('heading', { name: 'Login event' })).toHaveCount(0);
  await expect(page.getByText('No logins match these filters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  await page.goto('/connection-errors?selected=he1');
  await expect(page.getByText('Error Detail', { exact: true })).toBeVisible();
  await page.getByPlaceholder('Error, request id, app, domain...').fill('unmatched-error');
  await expect(page.getByText('Error Detail', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Select an error to inspect', { exact: false })).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('access bans expose all four kinds and filter without losing rules', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/bans');
  for (const [kind, count] of [
    ['emails', 3],
    ['patterns', 3],
    ['ips', 3],
    ['users', 1],
  ] as const) {
    await page.getByRole('combobox', { name: 'Ban type' }).selectOption(kind);
    await expect(page.locator('main tbody tr')).toHaveCount(count);
    await expect(page.locator('main tbody tr').first().locator('td').nth(1)).toHaveText(kind);
  }
  await page.getByRole('combobox', { name: 'Ban type' }).selectOption('');
  await expect(page.locator('main tbody tr')).toHaveCount(10);
  await page.getByRole('searchbox', { name: 'Search bans' }).fill('unmatched-ban');
  await expect(page.getByText('No bans match these filters.')).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('record Back button returns to the service directory tab and search', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/domains?q=Acme');
  await page.getByRole('link', { name: 'Acme App', exact: true }).click();
  await page.getByRole('link', { name: /View .* users/ }).click();
  await page.getByPlaceholder('Search by name or email...').fill('Alice');
  await page.getByRole('link', { name: 'Alice Chen', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/u101$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5274/domains/app.acme.com?tab=users&q=Alice');
  await expect(page.getByPlaceholder('Search by name or email...')).toHaveValue('Alice');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:5274/domains?q=Acme');
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('nested credential confirmation Escape preserves its request review', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/integrations?status=ALL&request=request-1');
  await page.getByRole('button', { name: 'Reveal Secret Here' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(
    page.getByRole('dialog', { name: 'Integration Request', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/request=request-1/);
  await page.getByRole('link', { name: 'Open website service' }).click();
  await expect(page).toHaveURL(/\/domains\/app.acme.com$/);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('billing product and contract selection, invoice guards and retry preserve context', async ({
  page,
}) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?section=products');
  await page.getByRole('link', { name: 'Fixture product', exact: true }).click();
  await expect(page).toHaveURL(/product=billing-1/);
  await expect(page.getByRole('heading', { name: 'Fixture product', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'All products' }).click();
  await expect(page.getByRole('link', { name: 'Fixture product', exact: true })).toBeVisible();
  await page.goto('/billing?section=contracts');
  await page.getByRole('link', { name: 'Enterprise AI services', exact: true }).click();
  await expect(page.locator('input[name="contractId"]')).toHaveValue('contract-1');
  await page.getByRole('link', { name: 'All contracts' }).click();
  await page.getByRole('link', { name: 'Second contract', exact: true }).click();
  await expect(page.locator('input[name="contractId"]')).toHaveValue('contract-2');
  await page.locator('input[name="billingMonth"]').fill('2026-07');
  await page.getByRole('button', { name: 'Calculate draft', exact: true }).click();
  await expect(page).toHaveURL(/invoice=draft-2/);
  await expect(page.getByRole('dialog', { name: 'Draft invoice · 2026-07' })).toBeVisible();
  await page.goto('/billing?section=contracts&contract=contract-1');
  await page.getByRole('link', { name: 'UOA-2026-000001', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'UOA-2026-000001', exact: true });
  await expect(dialog).toBeVisible();
  expect(fixture.calculations).toEqual([
    { contract_id: 'contract-2', issuer_profile_id: 'issuer-1', billing_month: '2026-07' },
  ]);
  await expect(dialog.getByRole('button', { name: 'Issue invoice', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Void invoice', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeVisible();
  await dialog.getByRole('link', { name: 'View organisation' }).click();
  await expect(page).toHaveURL(/organisations\/o1$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Record payment activity' }).click();
  await expect(dialog.getByRole('option', { name: 'Refund', exact: true })).toBeAttached();
  await expect(dialog.getByRole('option', { name: 'Payment', exact: true })).toHaveCount(0);
  const amount = dialog.locator('input[name="amountMinor"]');
  await amount.fill('15001');
  await dialog.getByRole('button', { name: 'Record activity', exact: true }).click();
  await expect(dialog.getByText('Amount cannot exceed $150.00.')).toBeVisible();
  expect(fixture.payments).toHaveLength(0);
  await amount.fill('1200');
  await dialog.getByRole('button', { name: 'Record activity', exact: true }).click();
  await expect(dialog.getByText(/HTTP 503/)).toBeVisible();
  await expect(amount).toHaveValue('1200');
  await dialog.getByRole('button', { name: 'Record activity', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Record activity', exact: true })).toHaveCount(0);
  expect(fixture.payments).toHaveLength(2);
  expect(fixture.payments[1]).toEqual(fixture.payments[0]);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'UOA-2026-000001', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('new billing terms show the prospective 30 percent default', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/billing?section=products');
  await page.getByRole('button', { name: 'Add service' }).click();
  const serviceDialog = page.getByRole('dialog', { name: 'Add billing service' });
  await expect(serviceDialog).toBeVisible();
  await expect(serviceDialog.getByLabel('Markup (basis points)')).toHaveValue('3000');
  await serviceDialog.screenshot({ path: 'e2e/artifacts/billing-service-default.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Fixture product', exact: true }).click();
  await page.getByRole('button', { name: 'Tariff version' }).click();
  const tariffDialog = page.getByRole('dialog', { name: /Add tariff version/ });
  await expect(tariffDialog).toBeVisible();
  await expect(tariffDialog.getByLabel('Markup (basis points)')).toHaveValue('3000');
  await tariffDialog.screenshot({ path: 'e2e/artifacts/billing-tariff-default.png' });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});


test('user add-to-team retains organisation team and role on failed save, then refreshes membership', async ({ page }) => {
  const fixture = await installFixtures(page);
  await page.goto('/users/u101');
  await expect(page.getByRole('link', { name: 'Platform', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add to team', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add User to Team', exact: true });
  await dialog.getByRole('combobox', { name: 'Organisation', exact: true }).selectOption('o3');
  await dialog.getByRole('combobox', { name: 'Target team', exact: true }).selectOption('t32');
  await dialog.getByRole('combobox', { name: 'Team role', exact: true }).selectOption('admin');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Discard unsaved changes?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not add the user.');
  await expect(dialog.getByRole('combobox', { name: 'Organisation', exact: true })).toHaveValue('o3');
  await expect(dialog.getByRole('combobox', { name: 'Target team', exact: true })).toHaveValue('t32');
  await expect(dialog.getByRole('combobox', { name: 'Team role', exact: true })).toHaveValue('admin');
  expect(fixture.memberships).toEqual([{ orgId: 'o3', teamId: 't32', teamRole: 'admin' }]);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.memberships).toEqual([
    { orgId: 'o3', teamId: 't32', teamRole: 'admin' },
    { orgId: 'o3', teamId: 't32', teamRole: 'admin' },
  ]);
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Platform', exact: true }) });
  await expect(row).toContainText('Widgets Core');
  await expect(row.locator('td').nth(3)).toHaveText('admin');
  await expect(row.getByRole('link', { name: 'Platform', exact: true })).toHaveAttribute('href', '/organisations/o3/teams/t32');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Platform', exact: true })).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
