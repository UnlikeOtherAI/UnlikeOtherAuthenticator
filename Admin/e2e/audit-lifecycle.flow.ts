import { expect, test, type Page, type Route } from '@playwright/test';
import { installFixtures } from './fixtures';
import { settledScreenshot } from './audit-screenshot';

const secret = 'synthetic-delayed-secret';
const issued = {
  id: 'key-1',
  purpose: 'entitlement',
  name: 'Fixture key',
  key: secret,
  key_prefix: 'synthetic',
  actor_issuer: 'https://product.example',
  actor_audience: 'fixture',
  actor_key_id: 'fixture',
  checkout_return_origins: [],
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_by_email: 'operator@example.test',
  created_at: '2026-10-14',
};

async function deferred(page: Page, pattern: string) {
  let pending: Route | undefined;
  let requests = 0;
  await page.route(pattern, async (route) => {
    if (route.request().method() === 'GET' && !pattern.endsWith('/session'))
      return route.fallback();
    requests++;
    pending = route;
  });
  return {
    wait: async () => {
      await expect.poll(() => pending !== undefined).toBe(true);
    },
    finish: async (json: unknown) => {
      if (!pending) throw new Error('No deferred response');
      const response = page.waitForResponse((res) => res.url() === pending?.request().url());
      await pending.fulfill({ json });
      await response;
      pending = undefined;
      // Let response parsing, mutation callbacks and committed effects settle.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    },
    count: () => requests,
  };
}

async function clearSession(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/features/auth/admin-session-storage.ts';
    (await import(/* @vite-ignore */ path)).clearStoredAdminSession();
  });
}

test.beforeEach(async ({ page }) => {
  await installFixtures(page);
  await page.route('**/internal/admin/session', (route) =>
    route.fulfill({ json: { adminUser: { email: 'operator@example.test' } } }),
  );
});

async function authenticated(page: Page) {
  await page.addInitScript(() =>
    sessionStorage.setItem(
      'uoa-admin-session',
      JSON.stringify({ accessToken: 'synthetic-admin', expiresAt: Date.now() + 600000 }),
    ),
  );
}

test('deferred domain rotation stays in its selected domain and original active Credentials owner', async ({
  page,
}, info) => {
  await authenticated(page);
  const response = await deferred(page, '**/domains/*/rotate-secret');
  await page.goto('/domains/app.acme.com');
  await page.getByLabel('Friendly name').fill('Unsaved friendly draft');
  await page.getByRole('button', { name: 'Credentials', exact: true }).click();
  async function rotate() {
    await page.getByRole('button', { name: 'Rotate and reveal once' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Rotate .* and reveal the new secret/ })
      .click();
    await response.wait();
  }
  const result = {
    delivery_mode: 'reveal',
    domain: 'app.acme.com',
    hash_prefix: 'fixture',
    credentials: {
      domain: 'app.acme.com',
      client_secret: secret,
      client_hash: 'fixture',
      hash_prefix: 'fixture',
    },
  };
  await rotate();
  await page.goBack();
  await expect(page.getByLabel('Friendly name')).toHaveValue('Unsaved friendly draft');
  await response.finish(result);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Credentials', exact: true }).click();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await rotate();
  await response.finish(result);
  await expect(page.getByText(secret, { exact: true })).toBeVisible();
  await settledScreenshot(page, info, 'domain-active-reveal.png');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.goto('/domains/widgets.io?tab=credentials');
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rotate and reveal once' })).toBeVisible();
  expect(response.count()).toBe(2);
});

test('deferred product key cannot reopen Billing after tab navigation; active issuance remains usable', async ({
  page,
}, info) => {
  await authenticated(page);
  const response = await deferred(page, '**/billing/services/*/app-keys');
  await page.goto('/billing?product=billing-1');
  await page.getByRole('button', { name: /App keys/ }).click();
  async function issue() {
    await page.getByRole('button', { name: 'Product key', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Purpose/).selectOption('entitlement');
    await dialog.getByLabel(/^Key name/).fill('Fixture deployment');
    await dialog.getByLabel(/^Actor issuer/).fill('https://product.example');
    await dialog
      .getByLabel(/^Actor public JWK/)
      .fill('{"kty":"RSA","kid":"fixture","n":"fixture","e":"AQAB"}');
    await dialog.getByRole('button', { name: 'Issue app key', exact: true }).click();
    await response.wait();
  }
  await issue();
  await page.goBack();
  await response.finish(issued);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /App keys/ }).click();
  await issue();
  await response.finish(issued);
  await expect(page.getByText(secret, { exact: true })).toBeVisible();
  await settledScreenshot(page, info, 'product-active-reveal.png');
  await page.getByRole('button', { name: 'I have stored this key' }).click();
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  expect(response.count()).toBe(2);
});

test('deferred automation response cannot reveal after session clearing and auth-shell teardown', async ({
  page,
}, info) => {
  await authenticated(page);
  const response = await deferred(page, '**/internal/admin/api-keys');
  await page.goto('/api-keys');
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByRole('dialog').locator('input').first().fill('Fixture deployment');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await response.wait();
  await clearSession(page);
  await expect(page).toHaveURL(/login/);
  await response.finish(issued);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('uoa-admin-session'))).toBeNull();
  await settledScreenshot(page, info, 'automation-cleared-login.png');
});

for (const kind of ['automation', 'product']) {
  test(`${kind} hook discards deferred delivery after close-reopen, unmount and session clear`, async ({
    page,
  }, info) => {
    for (const transition of ['close', 'unmount', 'clear']) {
      const response = await deferred(
        page,
        kind === 'automation' ? '**/internal/admin/api-keys' : '**/billing/services/*/app-keys',
      );
      await page.goto(`/e2e/audit-lifecycle.html?kind=${kind}`);
      await page.getByRole('button', { name: 'Issue fixture key' }).click();
      await response.wait();
      if (transition === 'close') {
        await page.getByRole('button', { name: 'Close owner' }).click();
        await page.getByRole('button', { name: 'Reopen owner' }).click();
      } else if (transition === 'unmount') {
        await page.getByRole('button', { name: 'Unmount owner' }).click();
        await page.getByRole('button', { name: 'Mount owner', exact: true }).click();
      } else await page.getByRole('button', { name: 'Clear session' }).click();
      await response.finish(issued);
      await expect(page.getByRole('status')).toHaveText('No secret revealed');
      expect(await page.evaluate('window.auditCache()')).not.toContain(secret);
      expect(
        await page.evaluate(() =>
          JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]),
        ),
      ).not.toContain(secret);
      expect(response.count()).toBe(1);
    }
    await settledScreenshot(page, info, `${kind}-settled-lifecycle.png`);
  });
}

test('U37 rejects late validation after explicit clear and permits a legitimate fresh sign-in', async ({
  page,
}, info) => {
  const response = await deferred(page, '**/internal/admin/session');
  await page.goto('/e2e/audit-lifecycle.html?kind=session');
  await page.getByRole('button', { name: 'Validate login' }).click();
  await response.wait();
  await page.getByRole('button', { name: 'Clear session' }).click();
  await response.finish({ adminUser: { email: 'operator@example.test' } });
  await expect(page.getByText('Superseded validation rejected')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Signed out');
  expect(await page.evaluate(() => sessionStorage.getItem('uoa-admin-session'))).toBeNull();
  await page.getByRole('button', { name: 'Validate login' }).click();
  await response.wait();
  await response.finish({ adminUser: { email: 'operator@example.test' } });
  await expect(page.getByRole('status')).toHaveText('Authenticated');
  expect(await page.evaluate(() => sessionStorage.getItem('uoa-admin-session'))).toContain(
    'fixture-login',
  );
  expect(response.count()).toBe(2);
  await settledScreenshot(page, info, 'fresh-sign-in.png');
});

test('same-owner StrictMode sign-in survives replay with one validation request', async ({
  page,
}, info) => {
  const response = await deferred(page, '**/internal/admin/session');
  await page.goto('/e2e/audit-lifecycle.html?kind=strict');
  await response.wait();
  await response.finish({ adminUser: { email: 'operator@example.test' } });
  await expect(page.getByRole('status')).toHaveText('Authenticated');
  expect(response.count()).toBe(1);
  await settledScreenshot(page, info, 'strict-owner-sign-in.png');
});
