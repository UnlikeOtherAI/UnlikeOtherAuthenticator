import { describe, expect, it, vi } from 'vitest';

import { renderAuthEntrypointHtml } from '../../src/services/auth-ui.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
Reflect.deleteProperty(process.env, 'DATABASE_URL');
process.env.SHARED_SECRET ??= 'test-shared-secret-with-enough-length';
process.env.AUTH_SERVICE_IDENTIFIER ??= 'uoa-auth-service';

vi.mock('@unlikeotherai/qr-art', () => ({
  renderSVG: () => '<svg />',
}));

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    query?: { config_url?: string };
    configUrl?: string;
    config?: ClientConfig;
  }): Promise<void> => {
    request.configUrl = request.query?.config_url;
    request.config = baseConfig();
  },
}));

function baseConfig(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
    access_requests: { enabled: false, notify_org_roles: ['owner', 'admin'] },
    org_features: {
      enabled: false,
      groups_enabled: false,
      user_needs_team: false,
      auto_create_personal_org_on_first_login: false,
      allow_user_create_org: false,
      pending_invites_block_auto_create: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      max_flags_per_app: 100,
      scim_override_retention: 'retain',
      global_missing_flag_default: 'disabled',
    },
    session: {
      remember_me_enabled: true,
      remember_me_default: true,
      short_refresh_token_ttl_hours: 1,
      long_refresh_token_ttl_days: 30,
    },
  } as ClientConfig;
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  return found ?? '';
}

describe('script-src CSP nonce', () => {
  it('serves non-auth responses with a script nonce and an unsafe-inline, nonce-free style-src', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/api' });
      expect(res.statusCode).toBe(200);
      const csp = String(res.headers['content-security-policy']);
      const scriptSrc = directive(csp, 'script-src');
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).toMatch(/'nonce-[a-f0-9]{32}'/);
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      const styleSrc = directive(csp, 'style-src');
      expect(styleSrc).toContain("'unsafe-inline'");
      expect(styleSrc).not.toContain('nonce');
    } finally {
      await app.close();
    }
  });

  it('serves the inline-style 2FA reset page under a style-src that permits its inline styles', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/email/twofa-reset?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&token=test-token',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // The page relies on inline style="..." attributes — verify it actually ships them.
      expect(res.body).toContain('style="');

      const csp = String(res.headers['content-security-policy']);
      const styleSrc = directive(csp, 'style-src');
      // Style attributes can only be authorised by 'unsafe-inline' (a nonce never can),
      // so style-src must keep it and must NOT carry a nonce (a nonce would make the
      // browser ignore 'unsafe-inline' in the same directive).
      expect(styleSrc).toContain("'unsafe-inline'");
      expect(styleSrc).not.toContain('nonce');
    } finally {
      await app.close();
    }
  });

  it('emits the bootstrap <script> with the per-request nonce', async () => {
    const html = await renderAuthEntrypointHtml({
      config: baseConfig(),
      configUrl: 'https://client.example.com/auth-config',
      requestUrl: '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      cspNonce: 'abc123nonce',
    });

    expect(html).toContain('<script nonce="abc123nonce">');
    expect(html).toContain('window.__UOA_CLIENT_CONFIG__');
  });

  it('nonce in the header matches the nonce on the bootstrap script tag, and no unsafe-inline', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');

      const csp = String(res.headers['content-security-policy']);
      const scriptSrc = directive(csp, 'script-src');
      expect(scriptSrc).not.toContain("'unsafe-inline'");

      // style-src must keep 'unsafe-inline' (inline <style> blocks and style="..."
      // attributes on the server-rendered pages) and must NOT carry a nonce.
      const styleSrc = directive(csp, 'style-src');
      expect(styleSrc).toContain("'unsafe-inline'");
      expect(styleSrc).not.toContain('nonce');

      const headerNonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
      expect(headerNonce).toBeTruthy();

      const bodyNonces = [...res.body.matchAll(/<script nonce="([^"]+)">/g)].map((m) => m[1]);
      expect(bodyNonces).toEqual([headerNonce]);
      expect(res.body).toContain('window.__UOA_CLIENT_CONFIG__');

      // Nonces must be per-request: a second request gets a fresh value.
      const res2 = await app.inject({
        method: 'GET',
        url: '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      });
      const scriptSrc2 = directive(String(res2.headers['content-security-policy']), 'script-src');
      const headerNonce2 = /'nonce-([^']+)'/.exec(scriptSrc2)?.[1];
      expect(headerNonce2).toBeTruthy();
      expect(headerNonce2).not.toBe(headerNonce);
    } finally {
      await app.close();
      if (originalDatabaseUrl === undefined) {
        Reflect.deleteProperty(process.env, 'DATABASE_URL');
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});
