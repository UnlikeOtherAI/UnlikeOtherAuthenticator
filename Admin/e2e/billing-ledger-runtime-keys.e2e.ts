import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installFixtures } from './fixtures';

test('operator reaches product runtime keys, reviews binding, retries and clears one-time reveal', async ({ page }, info) => {
  const fixture = await installFixtures(page);
  const now = '2026-10-07T12:00:00.000Z';
  const secret = `uoa_ledger_${'a'.repeat(43)}`; // Synthetic only; never a live credential.
  const keys: Array<Record<string, unknown>> = [{ id: 'other-product-key', product: 'deepwater',
    key_prefix: 'uoa_ledger_other', source_domain: 'api.deepwater.example',
    ledger_audience: 'https://ledger.example', created_at: now, revoked_at: null }];
  const writes: unknown[] = []; const revocations: string[] = [];
  let listFailures = 1;
  await page.route('**/internal/admin/billing/services', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(['nessie', 'deepwater'].map((identifier) => ({
      id: identifier, name: identifier === 'nessie' ? 'Nessie' : 'DeepWater', identifier,
      active: true, tariffs: [], assignments: [], app_keys: [], adjustments: [],
      stripe_catalogs: [], stripe_subscriptions: [], created_at: now, updated_at: now,
    }))),
  }));
  await page.route('**/internal/admin/billing/ledger-runtime-keys**', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status,
      contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(body) });
    if (req.method() === 'GET') {
      if (listFailures-- > 0) return json({ error: 'Synthetic list failure' }, 503);
      return json({ keys });
    }
    if (req.method() === 'POST' && url.pathname.endsWith('/runtime-1/revoke')) {
      revocations.push('runtime-1');
      const key = keys.find((item) => item.id === 'runtime-1');
      if (key) key.revoked_at = now;
      return json({ id: 'runtime-1', revoked_at: now });
    }
    const input = req.postDataJSON(); writes.push(input);
    expect(input).toEqual({ product: 'nessie', source_domain: 'api.nessie.works',
      ledger_audience: 'https://ledger.unlikeotherai.com' });
    if (writes.length === 1) return json({ error: 'Synthetic issuance failure' }, 503);
    keys.push({ ...input, id: 'runtime-1', key_prefix: 'uoa_ledger_fixture',
      created_at: now, revoked_at: null });
    return json({ id: 'runtime-1', key_prefix: 'uoa_ledger_fixture', created_at: now, secret });
  });
  await page.goto('/billing');
  await page.getByRole('link', { name: 'Nessie', exact: true }).click();
  await page.getByRole('button', { name: 'Ledger runtime keys', exact: true }).click();
  await expect(page).toHaveURL(/product=nessie.*tab=runtime-keys/);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('No Ledger runtime keys have been issued for Nessie.')).toBeVisible();
  await expect(page.getByText('uoa_ledger_other')).toHaveCount(0);
  await page.getByRole('button', { name: 'Issue runtime key', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(/^Product/)).toHaveValue('nessie');
  await dialog.getByLabel(/^Source domain/).fill('api.nessie.works');
  await dialog.getByLabel(/^Ledger audience/).fill('https://ledger.unlikeotherai.com');
  const proof = process.env.UOA_RUNTIME_KEY_PROOF_DIR;
  if (proof) {
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, `runtime-key-form-${info.project.name}.png`), fullPage: true });
  }
  await dialog.getByRole('button', { name: 'Issue runtime key', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Check the key list');
  await expect(dialog.getByLabel(/^Source domain/)).toHaveValue('api.nessie.works');
  await page.keyboard.press('Escape');
  await expect(dialog).toContainText('Discard unsaved changes?');
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await dialog.getByRole('button', { name: 'Issue runtime key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ledger runtime key issued' })).toBeVisible();
  await expect(dialog).toContainText(secret);
  expect(await page.evaluate((value) => JSON.stringify({ local: { ...localStorage },
    session: { ...sessionStorage }, url: location.href }).includes(value), secret)).toBe(false);
  await dialog.getByRole('button', { name: 'I have stored this key' }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByText('uoa_ledger_fixture', { exact: true })).toBeVisible();
  if (proof) await page.screenshot({ path: path.join(proof, `runtime-key-list-${info.project.name}.png`), fullPage: true });
  await page.reload();
  await expect(page.getByText('uoa_ledger_fixture', { exact: true })).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('api.nessie.works');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  expect(revocations).toEqual(['runtime-1']); expect(writes).toHaveLength(2);
  expect(fixture.unexpected).toEqual([]); expect(fixture.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
