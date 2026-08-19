import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

describe('GET /auth (config failure disclosure)', () => {
  const originalDebugEnabled = process.env.DEBUG_ENABLED;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSharedSecret = process.env.SHARED_SECRET;

  afterEach(() => {
    restoreEnv('DEBUG_ENABLED', originalDebugEnabled);
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('SHARED_SECRET', originalSharedSecret);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves a generic, non-disclosing HTML page to an anonymous production browser on config schema failure', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    process.env.NODE_ENV = 'production';
    // Production env validation requires a longer SHARED_SECRET.
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length-for-production';
    delete process.env.DEBUG_ENABLED;

    const jwt = await signTestConfigJwt({
      ...baseClientConfigPayload(),
      ui_theme: {
        typography: {
          font_family: 'sans-serif',
          base_text_size: 'md',
        },
        logo: {
          url: 'https://client.example.com/logo.svg',
          alt: 'Client logo',
          text: 'Client',
        },
      },
    });

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://attacker.example.net/phish/callback';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}&redirect_url=${encodeURIComponent(redirectUrl)}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<h1>Request failed</h1>');
    expect(res.body).toContain('<code>CONFIG_SCHEMA_INVALID</code>');
    expect(res.body).not.toContain('Auth configuration error');
    expect(res.body).not.toContain('Allowlisted redirect_urls');
    expect(res.body).not.toContain('ui_theme.colors');
    expect(res.body).not.toContain('Full config example');
    expect(res.body).not.toContain('attacker.example.net');
    expect(res.body).not.toContain('client.example.com');
    expect(res.body).not.toContain(process.env.SHARED_SECRET);

    await app.close();
  });

  it('still renders the debug page to the operator when DEBUG_ENABLED=true, with placeholder example values', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
    // NODE_ENV stays 'test': getEnv() only re-reads mutated env in test mode.
    // The operator gate is DEBUG_ENABLED alone; NODE_ENV=production with
    // DEBUG_ENABLED unset is covered by the anonymous case above.
    process.env.DEBUG_ENABLED = 'true';

    const jwt = await signTestConfigJwt({
      ...baseClientConfigPayload(),
      ui_theme: {
        typography: {
          font_family: 'sans-serif',
          base_text_size: 'md',
        },
        logo: {
          url: 'https://client.example.com/logo.svg',
          alt: 'Client logo',
          text: 'Client',
        },
      },
    });

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const redirectUrl = 'https://client.example.com/auth/callback';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}&redirect_url=${encodeURIComponent(redirectUrl)}`,
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Auth configuration error');
    expect(res.body).toContain('CONFIG_SCHEMA_INVALID');
    expect(res.body).toContain('ui_theme.colors');
    expect(res.body).toContain('Full config example');
    expect(res.body).toContain('https://example.com/auth/callback');
    expect(res.body).toContain('https://example.com/logo.svg');
    // The example must not be minted per-tenant from the request or config:
    // the caller's config_url origin and requested redirect_url stay out of it.
    const exampleStart = res.body.indexOf('Full config example');
    const exampleSection = res.body.slice(exampleStart);
    expect(exampleSection).not.toContain('auth-config');
    expect(exampleSection).not.toContain('client.example.com/auth/callback');

    await app.close();
  });
});
