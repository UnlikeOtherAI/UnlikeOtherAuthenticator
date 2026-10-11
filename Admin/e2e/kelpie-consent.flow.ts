import { expect, test } from '@playwright/test';

test('native hosted consent explains the Nessie connection before account sign-in', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.assign(window, { __UOA_CLIENT_CONFIG__: {
      enabled_auth_methods: ['email_password', 'google'], allow_registration: false, language_config: 'en',
      ui_theme: { colors: { bg: '#ffffff', surface: '#ffffff', text: '#111827', muted: '#475569',
        primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
      radii: { card: '12px', input: '8px', button: '8px' }, density: 'comfortable',
      typography: { font_family: 'sans-serif', base_text_size: 'md' }, button: { style: 'solid' },
      card: { style: 'bordered' }, logo: { url: '', alt: 'Kelpie' } },
    }, __UOA_CONFIG_URL__: '' });
  });
  const params = new URLSearchParams({ client_id: 'kelpie-client', redirect_uri: 'com.unlikeotherai.kelpie://oauth/callback',
    scope: 'openid profile email settings.read settings.write kelpie.connect' });
  await page.goto('/?' + params);
  await expect(page.getByText(/permission to connect this device to your Nessie account for work you request/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Google/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('kelpie-native-consent.png'), fullPage: true });
});
