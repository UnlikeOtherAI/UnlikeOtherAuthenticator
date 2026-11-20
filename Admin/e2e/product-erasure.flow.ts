import { expect, test } from '@playwright/test';

test('review product scope before confirming deletion', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.assign(window, { __UOA_CLIENT_CONFIG__: {
      enabled_auth_methods: ['email_password', 'google'], allow_registration: false, language_config: 'en',
      ui_theme: { colors: { bg: '#ffffff', surface: '#ffffff', text: '#111827', muted: '#475569',
        primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
      radii: { card: '12px', input: '8px', button: '8px' }, density: 'comfortable',
      typography: { font_family: 'sans-serif', base_text_size: 'md' }, button: { style: 'solid' },
      card: { style: 'bordered' }, logo: { url: '', alt: 'UnlikeOtherAI' } },
    }, __UOA_CONFIG_URL__: '' });
  });
  const policy = { name: 'Example Browser', disclosure: 'Synced favourites will be erased. Your local browsing history stays on this device.' };
  await page.route('**/auth/delete-account/product/browser', route => route.fulfill({ json: policy }));
  await page.route('**/auth/delete-account/start', route => route.fulfill({ json: { challengeId: 'example' } }));
  await page.route('**/auth/delete-account/confirm', route => route.fulfill({ json: { digest: 'example',
    impact: { ...policy, mode: 'PERSONAL', contexts: [], containers: [] } } }));
  await page.route('**/auth/delete-account/submit-product', route => {
    expect(route.request().postDataJSON()).toMatchObject({ product: 'browser', digest: 'example', challengeId: 'example' });
    return route.fulfill({ json: { receipt: 'example-receipt', complete: true } });
  });
  await page.goto('/auth/delete-account?product=browser');
  await expect(page.getByRole('heading', { name: 'Delete your Example Browser account' })).toBeVisible();
  await page.getByLabel('Account email').fill('alex@example.test');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Email verification code').fill('123456');
  await page.getByRole('button', { name: 'Review deletion' }).click();
  await expect(page.getByRole('link', { name: 'Delete my UnlikeOtherAI account everywhere' })).toHaveAttribute('href','/auth/delete-account');
  await page.screenshot({ path: info.outputPath('review-product.png'), fullPage: true });
  await page.getByRole('button', { name: 'Confirm permanent deletion' }).click();
  await expect(page.getByRole('status')).toContainText('Product account deletion complete');
  await expect(page.getByRole('link', { name: 'Check deletion status' })).toHaveAttribute('href','/auth/delete-account/receipt/example-receipt');
});
