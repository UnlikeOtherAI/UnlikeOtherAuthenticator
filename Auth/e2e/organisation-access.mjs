// Local, headless browser evaluation. Not invoked by CI or the ordinary test command.
// Start Auth's Vite server, set UOA_AUTH_PREVIEW and optionally PLAYWRIGHT_MODULE.
/* global window, document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = process.env.UOA_AUTH_PREVIEW ?? 'http://127.0.0.1:5187';
const output = process.env.UOA_SCREENSHOTS ?? 'Auth/e2e/artifacts/organisation-access';
await mkdir(output, { recursive: true });
const config = {
  language_config: ['en', 'cs', 'es'], language: 'en',
  ui_theme: {
    colors: { bg: '#f8fafc', surface: '#ffffff', text: '#0f172a', muted: '#475569', primary: '#2563eb',
      primary_text: '#ffffff', border: '#e2e8f0', danger: '#dc2626', danger_text: '#ffffff' },
    radii: { card: '16px', button: '8px', input: '8px' }, density: 'comfortable',
    typography: { font_family: 'sans', base_text_size: 'md' }, button: { style: 'solid' },
    card: { style: 'bordered' }, logo: { text: 'UnlikeOtherAI', alt: 'UnlikeOtherAI' },
  },
};
const base = {
  ok: true, org: { id: 'org-acme', name: 'Acme Research' }, client_domain: 'api.nessie.works', csrf_token: 'fixture-csrf',
  connections: [], domains: [], policy: { enforcement: 'off', revision: 1, session_max_age_seconds: 28800, reauth_mode: 'detect_only' },
  readiness: { activation_allowed: false, enforcement_allowed: false, blockers: ['RECOVERY_SETUP_REQUIRED', 'REVOCATION_CONSUMERS_REQUIRED'] },
  presets: ['entra', 'okta', 'google_workspace', 'keycloak', 'adfs', 'other_oidc', 'other_saml'].map((id) => ({ id, protocols: ['adfs', 'other_saml'].includes(id) ? ['saml'] : ['oidc'] })),
  scim: { enabled: false },
};
const saved = {
  id: 'connection-one', preset: 'entra', protocol: 'oidc', display_name: 'Acme Microsoft', status: 'draft',
  revision: 1, configuration: {}, secret_configured: true, tested_revision: null,
  callback_url: `${origin}/sso/connection-one/callback`,
  acs_url: `${origin}/sso/connection-one/acs`, sp_entity_id: `${origin}/sso/connection-one/metadata`,
};
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => console.error(error.message));
    await page.addInitScript((value) => { window.__UOA_CLIENT_CONFIG__ = value; }, config);
    let data = structuredClone(base);
    let mode = 'normal'; const mutations = [];
    await page.route('**/sso/connection-one/start', async (route) => {
      data.connections[0].tested_revision = 2;
      data.connections[0].last_test = { status: 'passed', code: 'OK', at: new Date().toISOString() };
      await route.fulfill({ status: 302, headers: { location: `${origin}/auth/organisation-access?test=connection-one` } });
    });
    await page.route('**/auth/organisation-access/**', async (route) => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path.endsWith('/exchange')) return route.fulfill({ json: data });
      if (request.method() === 'GET' && path.endsWith('/sso')) {
        if (mode === 'outage') return route.fulfill({ status: 503, json: { error: 'Request failed' } });
        if (mode === 'expired') return route.fulfill({ status: 401, json: { error: 'Request failed' } });
        return route.fulfill({ json: { ...data, domains: data.domains.map((domain) => ({ ...domain, challenge: undefined })) } });
      }
      assert.equal(request.headers()['x-uoa-csrf'], 'fixture-csrf');
      mutations.push({ path, body: request.postDataJSON() });
      if (path.endsWith('/connections')) {
        const body = request.postDataJSON();
        data.connections = [{ ...saved, ...body, secret: undefined }];
        return route.fulfill({ json: { ok: true, connection: data.connections[0] } });
      }
      if (request.method() === 'PATCH' && path.endsWith('/connections/connection-one')) {
        data.connections[0] = { ...data.connections[0], ...request.postDataJSON(), secret: undefined, revision: 2 };
        return route.fulfill({ json: { ok: true, connection: data.connections[0] } });
      }
      if (path.endsWith('/connections/connection-one/test')) {
        assert.equal(request.postDataJSON().revision, 2);
        return route.fulfill({ json: { ok: true, test_url: `${origin}/sso/connection-one/start`, expires_at: '2026-10-18T12:00:00Z' } });
      }
      if (path.endsWith('/connections/connection-one/scim-token')) {
        return route.fulfill({ json: { ok: true, token: 'fixture-one-time-provisioning-token', base_url: `${origin}/scim/v2/c/connection-one` } });
      }
      if (path.endsWith('/domains')) {
        data.domains.push({ id: 'domain-one', email_domain: 'acme.example', status: 'PENDING',
          challenge: { name: '_uoa-verify.acme.example', value: 'public-dns-proof', expires_at: '2026-10-18T12:00:00Z' } });
        return route.fulfill({ json: { ok: true, domain: data.domains.at(-1) } });
      }
      if (path.endsWith('/domains/domain-one/reissue')) {
        const domain = data.domains[0];
        domain.challenge.value = 'replacement-public-dns-proof';
        return route.fulfill({ json: { ok: true, domain } });
      }
      return route.fulfill({ status: 400, json: { error: 'Request failed' } });
    });
    const shot = async (name) => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: `${output}/${width}-${name}.png`, fullPage: true });
      console.log(`${width}: ${name}`);
    };
    await page.goto(`${origin}/auth/organisation-access#continuation=one-use-fixture`);
    await page.getByRole('button', { name: 'Choose provider', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, ''); await shot('first-time');
    await page.getByRole('button', { name: 'Choose provider', exact: true }).click(); await shot('choose');
    await page.getByRole('button', { name: 'Microsoft Entra ID', exact: true }).click(); await shot('connect');
    await page.getByLabel('Directory (tenant) ID').fill('11111111-1111-1111-1111-111111111111');
    await page.getByLabel('Application (client) ID').fill('application-id');
    await page.getByLabel('Client secret', { exact: true }).fill('fixture-write-only-secret');
    await page.getByRole('button', { name: 'Save connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Microsoft Entra ID', exact: true }).waitFor();
    await shot('saved-untested');
    const reply = page.locator('code').first();
    assert.ok((await reply.boundingBox()).width > 150, 'Reply URL must remain readable beside its copy action');
    assert.equal(await page.getByRole('button', { name: 'Turn on', exact: true }).count(), 0);
    assert.equal(await page.getByText('fixture-write-only-secret').count(), 0);
    assert.deepEqual(mutations[0].body.configuration, {});
    assert.equal(mutations[1].body.configuration.tenant.claim, 'tid');
    await page.getByRole('button', { name: 'Test sign-in', exact: true }).click();
    await page.getByText('Sign-in worked for this saved configuration.', { exact: false }).waitFor(); await shot('test-passed-blocked');
    data.connections[0].tested_revision = null; data.connections[0].last_test.status = 'failed';
    await page.reload(); await page.getByRole('button', { name: /Microsoft Entra ID/ }).click(); await shot('test-failed');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Email domains', exact: true }).click();
    await page.getByLabel('Email domain', { exact: true }).fill('acme.example');
    await page.getByRole('button', { name: 'Add domain', exact: true }).click();
    await page.getByText('public-dns-proof', { exact: true }).waitFor(); await shot('domain-pending');
    await page.reload(); await page.getByRole('button', { name: 'Email domains', exact: true }).click();
    await page.getByRole('button', { name: 'Get a new DNS record', exact: true }).click();
    await page.getByText('replacement-public-dns-proof', { exact: true }).waitFor(); await shot('domain-reissued');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Recovery and required sign-in', exact: true }).click(); await shot('recovery');
    await page.getByTestId('language-selector').selectOption('cs'); await shot('recovery-cs');
    await page.getByTestId('language-selector').selectOption('es'); await shot('recovery-es');
    mode = 'outage'; await page.reload(); await page.getByRole('alert').waitFor(); await shot('outage');
    mode = 'expired'; await page.reload(); await page.getByRole('alert').waitFor(); await shot('expired');
    mode = 'normal'; data.scim.enabled = true;
    await page.reload(); await page.getByRole('button', { name: /Microsoft Entra ID/ }).click();
    await page.getByText('Automatic access management', { exact: true }).click();
    await page.getByRole('button', { name: 'Create provisioning token', exact: true }).click();
    await page.getByText('fixture-one-time-provisioning-token', { exact: true }).waitFor(); await shot('provisioning-token-once');
    await page.getByRole('button', { name: 'I have saved the token', exact: true }).click();
    assert.equal(await page.getByText('fixture-one-time-provisioning-token', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await page.getByRole('button', { name: 'Other SAML', exact: true }).click();
    await page.getByLabel('Identity provider identifier', { exact: true }).waitFor(); await shot('saml-connect');
    assert.ok((await page.locator('code').first().boundingBox()).width > 150);
    await page.close();
  }
  console.log('Organisation access headless journeys passed at 390px and 1280px.');
} finally { await browser.close(); }
