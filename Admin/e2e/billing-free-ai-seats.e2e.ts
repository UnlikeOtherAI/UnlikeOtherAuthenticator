import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('a billing operator can waive AI usage and charge a monthly seat price', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  let submitted: unknown;
  await page.route('**/billing/services/billing-1/tariffs', async route => {
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON();
    submitted = body;
    return route.fulfill({ status: 201, json: { ...body, id: 'test-tariff', service_id: 'billing-1',
      version: 1, markup_bps: 0, is_default: false, created_by_email: null, created_at: '2026-11-04T12:00:00Z' } });
  });
  await page.goto('/billing?section=products');
  await page.getByRole('link', { name: 'Fixture product', exact: true }).click();
  await page.getByRole('button', { name: 'Tariff version' }).click();
  const dialog = page.getByRole('dialog', { name: /Add tariff version/ });
  await dialog.getByLabel('Tariff key').fill('internal-free-ai');
  await dialog.getByLabel('Name', { exact: true }).fill('Staff AI with paid seats');
  await dialog.getByLabel('Mode').selectOption({ label: 'Free AI usage' });
  await dialog.getByLabel('Markup (%)').fill('0');
  await dialog.getByLabel('Usage payment').selectOption('pay_as_you_go');
  await dialog.getByLabel('Collection').selectOption('stripe');
  await dialog.getByLabel('Monthly subscription basis').selectOption('per_seat');
  await dialog.getByLabel('Monthly price').fill('2.99');
  await dialog.getByLabel('Currency', { exact: true }).fill('EUR');
  await dialog.screenshot({ path: 'e2e/artifacts/free-ai-paid-seat-' + info.project.name + '.png' });
  await dialog.getByRole('button', { name: 'Create immutable version' }).click();
  await expect(dialog).toHaveCount(0);
  expect(submitted).toMatchObject({ key: 'internal-free-ai', mode: 'free', collection_mode: 'stripe', markup_percent: '0',
    usage_payment_mode: 'pay_as_you_go', monthly_subscription: { currency: 'EUR', amount_minor: '299', charge_basis: 'per_seat',
      seat_policy: 'automatic', seat_charge_timing: 'prorated' } });
  expect(fixture.unexpected).toEqual([]);
});
