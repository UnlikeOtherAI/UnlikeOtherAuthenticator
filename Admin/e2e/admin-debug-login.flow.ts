import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const syntheticToken = 'a'.repeat(43);
const syntheticBearer = 'synthetic-browser-fixture-admin-bearer';
const proof = process.env.UOA_DEBUG_EVIDENCE_DIR;
for (const inputKind of ['JSON', 'bare code']) test(`production issuer and ${inputKind} importer remain reachable`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let issued = 0; let redeemed = 0;
  await page.route('**/internal/admin/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/internal/admin/dashboard') return route.fulfill({ json: { stats: { users: 0, domains: 0, orgs: 0, loginsToday: 0 }, logs: [], handshakeErrors: [] } });
    if (url.pathname === '/internal/admin/session') return route.fulfill({ json: { adminUser: { email: 'fixture@example.test', role: 'superuser' } } });
    if (url.pathname === '/internal/admin/debug-login/issue') {
      issued++;
      const payload = route.request().postDataJSON();
      if (issued === 2) expect(payload.previous_token).toBe(syntheticToken);
      return route.fulfill({ json: { url: `${url.origin}/admin/login`, token: issued === 1 ? syntheticToken : 'b'.repeat(43), expires_in: 1800 } });
    }
    if (url.pathname === '/internal/admin/debug-login/redeem') {
      expect(route.request().postDataJSON()).toEqual({ token: syntheticToken });
      if (++redeemed > 1) return route.fulfill({ status: 401, json: { code: 'UNAUTHORIZED' } });
      return route.fulfill({ json: { access_token: syntheticBearer, expires_in: 1800, token_type: 'Bearer' } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/admin/login');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await page.getByRole('button', { name: 'Debug login', exact: true }).click();
  await page.getByLabel('Debug login code or JSON').fill(JSON.stringify({ url: `${new URL(page.url()).origin}/admin/login`, token: syntheticToken }));
  if (proof) { await mkdir(proof, { recursive: true }); await page.screenshot({ path: path.join(proof, `importer-${info.project.name}.png`), fullPage: true }); }
  await page.getByLabel('Debug login code or JSON').fill(JSON.stringify({ url: 'https://other.example/admin/login', token: syntheticToken }));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to use');
  await page.getByLabel('Debug login code or JSON').fill(inputKind === 'bare code' ? syntheticToken : JSON.stringify({ url: `${new URL(page.url()).origin}/admin/login`, token: syntheticToken }));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/admin\/dashboard/);
  await page.getByRole('button', { name: 'Debug login', exact: true }).click();
  await page.getByRole('button', { name: 'Create code' }).click();
  const exported = JSON.parse(await page.getByLabel('Debug login JSON').inputValue());
  expect(Object.keys(exported).sort()).toEqual(['token', 'url']);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(exported);
  await page.getByRole('button', { name: 'Renew', exact: true }).click();
  await expect(page.getByLabel('Debug login JSON')).toHaveValue(new RegExp('b'.repeat(43)));
  if (proof) await page.screenshot({ path: path.join(proof, `issuer-${info.project.name}.png`), fullPage: true });
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/admin/login');
  await page.getByRole('button', { name: 'Debug login', exact: true }).click();
  await page.getByLabel('Debug login code or JSON').fill(syntheticToken);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to use');
  await expect(page.getByLabel('Debug login code or JSON')).toHaveValue(syntheticToken);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
