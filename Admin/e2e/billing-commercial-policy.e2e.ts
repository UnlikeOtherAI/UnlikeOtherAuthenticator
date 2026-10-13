import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('operator reaches exact company policy, reviews effective date, binds storage and separates usage currency', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const now = '2026-10-13T18:00:00Z', effective = '2026-11-01T00:00:00Z';
  const tariffs: unknown[] = [];
  const policies: unknown[] = [];
  const catalogs: unknown[] = [];
  const writes: Array<Record<string, unknown>> = [];
  let rejected = true;
  const key = { id: 'lifecycle', service_id: 'billing-1', purpose: 'customer_lifecycle', name: 'Customer lifecycle',
    key_prefix: 'synthetic', actor_issuer: 'https://api.nessie.works', actor_audience: 'https://authentication.unlikeotherai.com',
    actor_key_id: 'synthetic', checkout_return_origins: ['https://app.nessie.works'], last_used_at: null,
    expires_at: null, revoked_at: null, created_by_email: null, created_at: now };
  await page.route('**/internal/admin/billing/services**', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
    if (url.pathname.endsWith('/services')) return json([{ id: 'billing-1', identifier: 'nessie', name: 'Nessie', active: true,
      tariffs, assignments: [], app_keys: [key], adjustments: [], stripe_catalogs: [], stripe_subscriptions: [], created_at: now, updated_at: now }]);
    if (url.pathname.endsWith('/product-policies')) {
      if (req.method() === 'GET') return json(policies);
      const input = req.postDataJSON(); writes.push(input);
      expect(input).toMatchObject({ organisation_id: 'o1', source_domain: 'api.nessie.works', billing_timezone: 'Europe/London' });
      if (rejected) { rejected = false; return json({ error: 'Unsupported partial waiver', code: 'BILLING_CUSTOM_TRIAL_PARTIAL_WAIVER_UNSUPPORTED' }, 409); }
      policies.splice(0, policies.length, { id: 'enrollment', organisation_id: 'o1', source_domain: input.source_domain,
        billing_timezone: input.billing_timezone, active: true, policy: { id: 'revision', privateAtCost: input.private_at_cost,
          effectiveAt: effective, trialStartsAt: null, trialEndsAt: null } });
      return json({ id: 'revision', effective_at: effective });
    }
    if (url.pathname.endsWith('/storage-catalogs')) {
      if (req.method() === 'GET') return json(catalogs);
      const input = req.postDataJSON(); expect(input).toEqual({ currency: 'EUR', price_id: 'price_synthetic123' });
      catalogs.push({ id: 'catalog', account_id: 'acct_synthetic', currency: 'EUR', unit_amount_minor: '999', price_id: input.price_id, version: 1 });
      return json(catalogs[0]);
    }
    if (url.pathname.endsWith('/tariffs') && req.method() === 'POST') {
      const input = req.postDataJSON(); writes.push(input);
      expect(input).toMatchObject({ collection_mode: 'stripe', usage_currency: 'USD', usage_payment_mode: 'prepaid', set_as_default: false,
        monthly_subscription: { amount_minor: '299', currency: 'EUR', charge_basis: 'per_seat', seat_policy: 'automatic', seat_charge_timing: 'prorated' } });
      const tariff = { ...input, id: 'tariff-eur-v2', service_id: 'billing-1', version: 2, markup_bps: 3000,
        is_default: false, created_by_email: null, created_at: now };
      tariffs.push(tariff); return json(tariff);
    }
    return route.fallback();
  });
  await page.goto('/billing');
  await page.getByRole('link', { name: 'Nessie', exact: true }).click();
  await page.getByRole('button', { name: 'Company policy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Company access and trials' })).toBeVisible();
  await page.getByLabel(/^Company$/).selectOption('o1');
  await page.getByLabel(/^Registered product source/).selectOption('api.nessie.works');
  await page.getByLabel(/^Billing timezone/).fill('Europe/London');
  await page.getByLabel(/^Company policy$/).selectOption('trial');
  await expect(page.getByLabel(/^Trial end/)).toBeVisible();
  await page.getByRole('button', { name: 'Save company policy' }).click();
  await expect(page.getByRole('alert')).toContainText('cannot receive a partial trial waiver');
  await expect(page.getByLabel(/^Billing timezone/)).toHaveValue('Europe/London');
  await page.getByLabel(/^Company policy$/).selectOption('private');
  await page.getByRole('button', { name: 'Save company policy' }).click();
  await expect(page.getByRole('status')).toContainText('Policy takes effect Sun, 01 Nov 2026');
  await expect(page.getByRole('cell', { name: 'Private at cost', exact: true })).toBeVisible();
  await page.getByLabel(/^Existing Stripe price/).fill('price_synthetic123');
  await page.getByRole('button', { name: 'Verify and bind price' }).click();
  await expect(page.getByText('Immutable storage price bound.')).toBeVisible();
  await expect(page.getByRole('cell', { name: '999', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('company-policy.png'), fullPage: true });
  await page.getByRole('button', { name: /^Tariffs/ }).click();
  await page.getByRole('button', { name: 'Tariff version', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Tariff key/).fill('standard-eur');
  await dialog.getByLabel(/^Collection/).selectOption('stripe');
  await dialog.getByLabel(/^Monthly subscription basis/).selectOption('per_seat');
  await dialog.getByLabel(/^Monthly price/).fill('2.99');
  await dialog.getByLabel(/^Monthly seat currency/).fill('EUR');
  await expect(dialog.getByLabel(/^Usage valuation currency/)).toHaveValue('USD');
  await page.screenshot({ path: info.outputPath('regional-tariff.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Create immutable version', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(3);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
