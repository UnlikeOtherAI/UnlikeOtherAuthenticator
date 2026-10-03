import { expect, test } from '@playwright/test';
import { mockAdminData } from '../src/features/admin/__mocks__/mock-data';
import type { ConfidentialDelegationMapping } from '../src/schemas/confidential-delegation';
import { installFixtures } from './fixtures';

test('broker-only delegation can be created, edited and reloaded', async ({ page }, testInfo) => {
  const fixture = await installFixtures(page);
  const mappings: ConfidentialDelegationMapping[] = [];
  const writes: Array<{ method: string; input: unknown }> = [];
  const createInput = {
    source_domain: 'coder.unlikeotherai.com',
    product: 'coder',
    resource: 'https://api.selkie.live',
    scopes: ['session:broker'],
    enabled: true,
  };
  const updateInput = {
    resource: createInput.resource,
    scopes: createInput.scopes,
    enabled: false,
  };
  await page.route('**/internal/admin/domains', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: [{ ...mockAdminData.domains[0], id: createInput.source_domain,
        name: createInput.source_domain, label: 'Coder', status: 'active' }],
    });
  });
  await page.route('**/internal/admin/confidential-delegations**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fallback();
    const input: unknown = request.postDataJSON();
    writes.push({ method: request.method(), input });
    if (request.method() === 'POST' &&
      new URL(request.url()).pathname === '/internal/admin/confidential-delegations') {
      expect(input).toEqual(createInput);
      const mapping: ConfidentialDelegationMapping = {
        ...createInput,
        scopes: ['session:broker'],
        id: 'broker-mapping',
        created_by_email: 'operator@example.test',
        updated_by_email: 'operator@example.test',
        created_at: '2026-10-03T12:00:00.000Z',
        updated_at: '2026-10-03T12:00:00.000Z',
      };
      mappings.push(mapping);
      return route.fulfill({ json: mapping });
    }
    if (request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/internal/admin/confidential-delegations/broker-mapping') {
      expect(input).toEqual(updateInput);
      mappings[0] = { ...mappings[0], enabled: false };
      return route.fulfill({ json: mappings[0] });
    }
    fixture.unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ status: 500, json: { error: 'Unexpected fixture write' } });
  });

  await page.route('**/internal/admin/confidential-delegations', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: mappings });
  });

  await page.goto('/delegations');
  await page.getByRole('button', { name: 'Create mapping' }).click();
  const dialog = page.getByRole('dialog');
  const broker = dialog.getByRole('checkbox', { name: /Session brokering/ });
  const ai = dialog.getByRole('checkbox', { name: /AI invocation/ });
  await expect(broker).not.toBeChecked();
  await expect(ai).toBeChecked();
  await dialog.getByRole('combobox', { name: 'Source domain' }).selectOption(createInput.source_domain);
  await dialog.locator('input[name="product"]').fill(createInput.product);
  await dialog.locator('input[name="resource"]').fill(createInput.resource);
  await ai.uncheck();
  await broker.check();
  await expect(broker).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('broker-create.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Create mapping' }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.locator('main tbody tr').filter({ hasText: createInput.source_domain });
  await expect(row).toContainText('session:broker');
  await expect(row).toContainText('Enabled');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(broker).toBeChecked();
  await expect(ai).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: /Mapping enabled/ }).uncheck();
  await broker.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('broker-edit.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(row).toContainText('session:broker');
  await expect(row).toContainText('Disabled');
  await page.screenshot({ path: testInfo.outputPath('broker-reloaded.png'), fullPage: true });
  expect(writes).toEqual([{ method: 'POST', input: createInput },
    { method: 'PATCH', input: updateInput }]);
  await testInfo.attach('broker-request-payloads', {
    body: JSON.stringify(writes, null, 2), contentType: 'application/json',
  });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});
