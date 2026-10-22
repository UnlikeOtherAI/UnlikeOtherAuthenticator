import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { renderRegistrationLinkPage } from '../../API/src/services/registration-link-page.service.js';
import { buildRegistrationVerificationTemplate } from '../../API/src/services/email.templates.registration.js';
import { buildVerifyEmailSetPasswordTemplate } from '../../API/src/services/email.templates.js';

const id = '9466e365-206c-49cb-a8d5-aa1342bdd613';
const search = '?config_url=https%3A%2F%2Fproduct.example%2Fconfig&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256&state=registration-csrf';
async function configure(page: Page) {
  await page.addInitScript(() => {
    Object.assign(window, {
      __UOA_CLIENT_CONFIG__: {
        app_name: 'Example product', enabled_auth_methods: ['email_password'], language_config: 'en',
        ui_theme: {
          colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb', primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
          radii: { card: '16px', input: '8px', button: '8px' }, density: 'comfortable',
          typography: { font_family: 'sans', base_text_size: 'md' },
          button: { style: 'solid' }, card: { style: 'bordered' }, logo: { url: '', alt: 'Example product' },
        },
      }, __UOA_CONFIG_URL__: 'https://product.example/config',
    });
  });
}
async function start(page: Page) {
  await page.goto(`/${search}`);
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('person@example.com');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}
async function backend(page: Page) {
  let status = 'pending';
  let socket: WebSocketRoute | undefined;
  let calls = 0;
  let starts = 0;
  await page.routeWebSocket('**/auth/registration/events?**', ws => { socket = ws; });
  await page.route('**/auth/registration/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/start')) {
      starts++;
      expect(route.request().postDataJSON()).toEqual({ email: 'person@example.com' });
      expect(url.searchParams.get('state')).toBe('registration-csrf');
      return route.fulfill({ json: { registration_id: id, message: 'We sent instructions to your email' } });
    }
    if (url.pathname.endsWith('/code')) {
      calls++;
      expect(route.request().postDataJSON().id).toBe(id);
      if (route.request().postDataJSON().code !== 'AB3K7M') return route.fulfill({ status: 400, json: { error: 'Request failed' } });
      status = 'authorized';
    }
    return route.fulfill({ json: status === 'authorized'
      ? { status, token: 'registration.synthetic-proof', token_type: 'VERIFY_EMAIL_SET_PASSWORD' } : { status } });
  });
  return {
    notify: async (next: string) => {
      status = next; await expect.poll(() => Boolean(socket)).toBe(true);
      if (!socket) throw new Error('Registration socket was not established');
      socket.send(JSON.stringify({ type: 'registration.email_verified', status: 'verified' }));
    },
    setStatus: (next: string) => { status = next; },
    calls: () => calls,
    starts: () => starts,
  };
}

test('registration screen, keyboard entry, failed code and full paste recovery', async ({ page }, info) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Verification code \d \/ 6/ });
  await expect(fields).toHaveCount(6);
  await expect(page.getByText(/person@example.com/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-registration.png'), fullPage: true });
  await fields.nth(0).pressSequentially('AAAAAA');
  await expect(page.getByRole('alert')).toContainText('We could not verify');
  await expect(fields.nth(0)).toHaveValue('A');
  await fields.nth(3).evaluate(element => {
    const data = new DataTransfer(); data.setData('text/plain', 'ab3k7m');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  expect(server.calls()).toBe(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
});

test('confirmation in another browser advances the original over websocket without code entry', async ({ page, browser }, info) => {
  await configure(page); const server = await backend(page);
  await page.clock.install(); // No polling interval runs: advancement must follow the socket hint.
  await start(page);
  const otherContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    const otherPage = await otherContext.newPage();
    await otherPage.route('**/auth/registration/link', async route => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
        await server.notify('authorized');
        return route.fulfill({ json: { status: 'verified' } });
      }
      return route.fulfill({ contentType: 'text/html', body: renderRegistrationLinkPage('synthetic-nonce') });
    });
    await otherPage.goto('http://127.0.0.1:5275/auth/registration/link#synthetic-link-secret');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await otherPage.getByRole('button', { name: 'Verify email address' }).click();
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
    expect(server.calls()).toBe(0);
    await expect(otherPage.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await expect(otherPage).toHaveURL('http://127.0.0.1:5275/auth/registration/link');
    expect(await otherContext.cookies()).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('cross-device-original-continued.png'), fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  } finally { await otherContext.close(); }
});

test('requesting another email preserves the address and clears only the old code', async ({ page }) => {
  await configure(page); const server = await backend(page); await start(page);
  const fields = page.getByRole('textbox', { name: /Verification code \d \/ 6/ });
  await fields.nth(0).fill('A');
  await page.getByRole('button', { name: 'Request a new email' }).click();
  await expect(fields.nth(0)).toHaveValue('');
  await expect(page.getByText('person@example.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(server.starts()).toBe(2);
});

test('link approval advances automatically when a blocked websocket falls back to polling', async ({ page }) => {
  await configure(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'WebSocket', { value: undefined }); });
  const server = await backend(page);
  await page.clock.install();
  await start(page);
  server.setStatus('authorized');
  await page.clock.fastForward(11000);
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
});

test('same-browser socket hint rechecks authority before advancing', async ({ page }) => {
  await configure(page); const server = await backend(page); await start(page);
  await server.notify('authorized');
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
});

test('another-device link displays success without navigation or authentication', async ({ page }, info) => {
  if (process.env.REGISTRATION_BASE_LINK_HTML) {
    await page.setContent(readFileSync(process.env.REGISTRATION_BASE_LINK_HTML, 'utf8'));
    await page.screenshot({ path: info.outputPath('before-confirmation.png'), fullPage: true });
  }
  await page.route('**/auth/registration/link', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ token: 'synthetic-link-secret' });
      return route.fulfill({ json: { status: 'verified' } });
    }
    return route.fulfill({ contentType: 'text/html', body: renderRegistrationLinkPage('synthetic-nonce') });
  });
  await page.goto('/auth/registration/link#synthetic-link-secret');
  await expect(page).toHaveURL(/\/auth\/registration\/link$/);
  await expect(page.getByText(/Only confirm if you requested this registration/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('after-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: 'Verify email address' }).click();
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('will continue automatically');
  await expect(page.getByRole('status')).toContainText('has not signed you in');
  await expect(page.getByRole('button', { name: 'Verify email address' })).toHaveCount(0);
  expect(await page.context().cookies()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('cross-device-success.png'), fullPage: true });
});

test('capture matching base-revision registration state', async ({ page }, info) => {
  test.skip(!process.env.REGISTRATION_BASE_URL, 'Set REGISTRATION_BASE_URL to a server from the base revision for before screenshots');
  await configure(page);
  await page.route('**/auth/register?**', route => route.fulfill({ json: { message: 'We sent instructions to your email' } }));
  await page.goto(`${process.env.REGISTRATION_BASE_URL}/${search}`);
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill('person@example.com');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('We sent instructions to your email', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('before-registration.png'), fullPage: true });
});

test('verification email shows the link and a large, spaced alternative code', async ({ page }, info) => {
  const link = 'https://auth.example.com/auth/registration/link#synthetic-link-secret';
  // The previous template is unchanged from the base revision.
  const previousLink = 'https://auth.example.com/auth/email/link?token=synthetic-link-secret&config_url=https%3A%2F%2Fproduct.example%2Fconfig';
  await page.setContent(buildVerifyEmailSetPasswordTemplate({ link: previousLink }).html);
  await page.screenshot({ path: info.outputPath('before-email.png'), fullPage: true });
  await page.setContent(buildRegistrationVerificationTemplate({ link, code: 'AB3K7M' }).html);
  await expect(page.getByRole('link', { name: 'Verify email address' })).toHaveAttribute('href', link);
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-size', '32px');
  await expect(page.getByText('AB3K7M', { exact: true })).toHaveCSS('font-weight', '700');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('after-email.png'), fullPage: true });
});
