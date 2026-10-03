import { expect, test } from '@playwright/test';

for (const native of [false, true]) {
  test(`${native ? 'native' : 'website'} mailbox proof reveals workplace reasons without signing in`, async ({ page }, info) => {
    await page.addInitScript(({ native }) => {
      Object.assign(window, {
        __UOA_CLIENT_CONFIG__: {
          app_name: 'Example product', enabled_auth_methods: ['email_password'], language: 'en',
          ui_theme: {
            colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
            radii: { card: '16px', input: '8px', button: '8px' }, density: 'comfortable',
            typography: { font_family: 'sans', base_text_size: 'md' },
            button: { style: 'solid' }, card: { style: 'bordered' }, logo: { url: '', alt: 'Example product' },
          },
        },
        __UOA_CONFIG_URL__: native ? '' : 'https://product.example/config',
      });
    }, { native });
    const prefix = native ? '/oauth' : '/auth';
    const calls: string[] = [];
    let attempts = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://127.0.0.1:5275') return route.abort();
      if (route.request().method() !== 'POST') return route.continue();
      calls.push(url.pathname);
      expect(url.searchParams.get(native ? 'client_id' : 'config_url')).toBe(native ? 'native-app' : 'https://product.example/config');
      if (native) expect(url.searchParams.get('redirect_uri')).toBe('example://oauth/callback');
      if (url.pathname === `${prefix}/lifecycle-status/start`) {
        expect(route.request().postDataJSON()).toEqual({ email: 'person@example.com' });
        return route.fulfill({ json: { challengeId: 'proof' } });
      }
      if (url.pathname === `${prefix}/lifecycle-status/verify`) {
        attempts++;
        if (attempts === 1) return route.fulfill({ status: 401, json: { error: 'Request failed' } });
        expect(route.request().postDataJSON()).toEqual({ challengeId: 'proof', code: '123456', twoFactorCode: '654321' });
        return route.fulfill({ json: {
          user: { id: 'user', status: 'ACTIVE', reason: null },
          organisations: [{ id: 'org', name: 'Example company', status: 'DISABLED', reason: 'Contact the administrator.' }],
          teams: [{ id: 'team', name: 'Engineering', status: 'ACTIVE', reason: null,
            parent: { id: 'org', name: 'Example company', status: 'DISABLED', reason: 'Contact the administrator.' } }],
        } });
      }
      return route.abort();
    });
    await page.goto(native ? '/?client_id=native-app&redirect_uri=example%3A%2F%2Foauth%2Fcallback' : '/');
    await page.getByRole('button', { name: 'Check access status', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).last().fill('person@example.com');
    await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await expect(page.getByText('If an eligible account exists, a verification code has been sent.')).toBeVisible();
    await expect(page.getByText('Example company', { exact: true })).toHaveCount(0);
    await page.getByLabel('Email verification code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'View access status', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not verify access status');
    await page.getByLabel('Authenticator code (if enabled)', { exact: true }).fill('654321');
    await page.getByRole('button', { name: 'View access status', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Example company');
    await expect(page.getByRole('status')).toContainText('Engineering');
    expect(calls).toEqual([`${prefix}/lifecycle-status/start`, `${prefix}/lifecycle-status/verify`, `${prefix}/lifecycle-status/verify`]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('verified-access-status.png'), fullPage: true });
  });
}
