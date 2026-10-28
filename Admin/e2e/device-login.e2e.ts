import { expect, test } from '@playwright/test';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import { installFixtures } from './fixtures';

test('numeric sign-in stays off until exact sites are saved and can be disabled again', async ({ page }, testInfo) => {
  const fixture = await installFixtures(page);
  const domain = { ...structuredClone(mockAdminData.domains[0]), deviceLoginConfigUrls: [] as string[] };
  const writes: unknown[] = [];
  let failNextSave = true;
  await page.route('**/internal/admin/domains/app.acme.com', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { domain, organisations: [], teams: [], users: [] } });
    }
    if (route.request().method() !== 'PATCH') return route.fallback();
    const input = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(input);
    if (failNextSave) {
      failNextSave = false;
      return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
    }
    expect(input).toEqual({
      allowed_email_domains: domain.allowedEmailDomains,
      allowed_emails: domain.allowedEmails,
      allowed_redirect_urls: domain.allowedRedirectUrls,
      device_login_config_urls: expect.any(Array),
    });
    domain.deviceLoginConfigUrls = input.device_login_config_urls as string[];
    return route.fulfill({ json: domain });
  });

  await page.goto('/domains/app.acme.com?tab=access');
  const sites = page.getByLabel('Enabled site config URLs');
  const save = page.getByRole('button', { name: 'Save changes', exact: true });
  await expect(sites).toHaveValue('');
  await expect(save).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Numeric device sign-in' })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
  });
  await page.locator('main').evaluate((main) => {
    const scroller = main.parentElement;
    if (!scroller) throw new Error('Missing Admin scroll container');
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.screenshot({ path: testInfo.outputPath('device-login-after-disabled.png'), fullPage: true });

  const configUrls = ['https://app.acme.com/config', 'https://app.acme.com/other-site/config'];
  await sites.fill(`  ${configUrls[0]}  \n\n${configUrls[1]}\n`);
  await save.click();
  await expect(page.getByText('Could not save. Check the domains, emails, and URLs and try again.'))
    .toBeVisible();
  await expect(sites).toHaveValue(`  ${configUrls[0]}  \n\n${configUrls[1]}\n`);
  await save.click();
  await expect(save).toBeDisabled();
  await expect(sites).toHaveValue(configUrls.join('\n'));
  await page.reload();
  await expect(sites).toHaveValue(configUrls.join('\n'));
  await expect(save).toBeDisabled();
  await page.locator('main').evaluate((main) => {
    const scroller = main.parentElement;
    if (!scroller) throw new Error('Missing Admin scroll container');
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.screenshot({ path: testInfo.outputPath('device-login-after-enabled.png'), fullPage: true });

  await sites.fill('');
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload();
  await expect(sites).toHaveValue('');
  expect(writes).toHaveLength(3);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[1]).toMatchObject({ device_login_config_urls: configUrls });
  expect(writes[2]).toMatchObject({ device_login_config_urls: [] });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
