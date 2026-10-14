import { expect, test } from '@playwright/test';
import { en } from '../../packages/auth-ui-strings/src/index';
import { settledScreenshot } from './audit-screenshot';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    Object.assign(window, {
      __UOA_CONFIG_URL__: 'https://product.example/config',
      __UOA_CLIENT_CONFIG__: {
        domain: 'product.example',
        redirect_urls: ['example://oauth/callback', 'https://product.example/callback'],
        enabled_auth_methods: ['email_password'],
        allow_registration: true,
        login_flow: { email_code_enabled: true },
        language_config: 'fr',
        ui_theme: {
          colors: {
            bg: '#f8fafc',
            surface: '#ffffff',
            text: '#0f172a',
            muted: '#475569',
            primary: '#2563eb',
            primary_text: '#ffffff',
            border: '#e2e8f0',
            danger: '#dc2626',
            danger_text: '#ffffff',
          },
          radii: { card: '16px', input: '8px', button: '8px' },
          density: 'comfortable',
          typography: { font_family: 'sans', base_text_size: 'md' },
          button: { style: 'solid' },
          card: { style: 'bordered' },
          logo: { url: '', alt: 'Example product' },
        },
      },
    }),
  );
});
test('remote translation settles; email code, resend, verify and registration preserve OAuth state', async ({
  page,
}, info) => {
  let translations = 0;
  const calls: string[] = [];
  await page.route('**/i18n/**', (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/i18n/')) return route.continue();
    translations++;
    return route.fulfill({ json: en });
  });
  await page.route('**/auth/**', (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('state')).toBe('opaque-state');
    calls.push(url.pathname);
    return route.fulfill({ json: url.pathname.endsWith('/verify-code') ? {} : { ok: true } });
  });
  await page.goto(
    '/?state=opaque-state&redirect_url=https%3A%2F%2Fproduct.example%2Fcallback&code_challenge=challenge&code_challenge_method=S256',
  );
  await page.getByLabel('Email', { exact: true }).fill('person@example.test');
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await page.getByRole('button', { name: 'Resend code' }).click();
  await page.locator('input[name=code]').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect.poll(() => calls.length).toBe(3);
  await expect(page.getByText('Could not verify the code. Please try again.')).toBeVisible();
  await settledScreenshot(page, info, 'email-code-retry.png');
  await page.goto('/?state=opaque-state');
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('new@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('We sent instructions');
  expect(calls).toContain('/auth/register');
  expect(translations).toBeLessThanOrEqual(2);
});
test('arbitrary HTTPS handoff remains on login while exact native callback retains handoff', async ({
  page,
}, info) => {
  await page.route('**/i18n/**', (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/i18n/')) return route.continue();
    return route.fulfill({ json: en });
  });
  await page.goto('/?handoff_target=https%3A%2F%2Fattacker.example%2F');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');
  await page.goto(
    '/?handoff_target=example%3A%2F%2Foauth%2Fcallback%3Fcode%3Done-use%26state%3Dopaque',
  );
  await expect(page.getByRole('button', { name: 'Open the app' })).toBeVisible();
  await settledScreenshot(page, info, 'native-handoff.png');
  await page.route('https://product.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Returned to product</p>' }),
  );
  await page.goto(
    '/?handoff_target=' +
      encodeURIComponent('https://product.example/callback?error=access_denied&state=opaque'),
  );
  await expect(page).toHaveURL('https://product.example/callback?error=access_denied&state=opaque');
});
