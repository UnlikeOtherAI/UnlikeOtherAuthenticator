import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../../src/app.js';
import {
  baseClientConfigPayload,
  createTestConfigFetchHandler,
  signTestConfigJwt,
} from '../helpers/test-config.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
  process.env.AUTH_SERVICE_IDENTIFIER =
    process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

  app = await createApp();
  await app.ready();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
});

describe('POST /config/verify', () => {
  it('reports schema errors for raw config payloads without requiring JWT checks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/config/verify',
      payload: {
        config: {
          domain: 'client.example.com',
          redirect_urls: ['https://client.example.com/oauth/callback'],
          enabled_auth_methods: ['email_password'],
          ui_theme: {
            radii: { card: '16px', button: '12px', input: '12px' },
            density: 'comfortable',
            typography: { font_family: 'sans', base_text_size: 'md' },
            button: { style: 'solid' },
            card: { style: 'bordered' },
            logo: { url: '', alt: 'Logo' },
          },
          language_config: 'en',
        },
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.source).toBe('config');
    expect(body.schema_valid).toBe(false);
    expect(body.jwt_signature_valid).toBeNull();
    expect(body.audience_valid).toBeNull();
    expect(body.checks.audience.status).toBe('skipped');
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        stage: 'schema',
        code: 'CONFIG_SCHEMA_INVALID',
      }),
    );
    expect(body.issues[0].details.join(' ')).toContain('ui_theme.colors');
  });

  it('reports a JWKS signature failure separately from schema validation', async () => {
    const jwt = await signTestConfigJwt(baseClientConfigPayload(), { kid: 'unknown-test-kid' });
    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const res = await app.inject({
      method: 'POST',
      url: '/config/verify',
      payload: {
        config_jwt: jwt,
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.schema_valid).toBe(true);
    expect(body.jwt_signature_valid).toBe(false);
    expect(body.audience_valid).toBe(true);
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        stage: 'signature',
        code: 'CONFIG_JWKS_SIGNATURE_INVALID',
      }),
    );
  });

  it('validates a fetched config_url and reports domain mismatches explicitly', async () => {
    const jwt = await signTestConfigJwt(
      baseClientConfigPayload({
        domain: 'different.example.com',
      }),
    );

    vi.stubGlobal('fetch', vi.fn(await createTestConfigFetchHandler(jwt)));

    const res = await app.inject({
      method: 'POST',
      url: '/config/verify',
      payload: {
        config_url: 'https://client.example.com/auth-config',
      },
    });

    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.source).toBe('config_url');
    expect(body.schema_valid).toBe(true);
    expect(body.jwt_signature_valid).toBe(true);
    expect(body.domain_match).toBe(false);
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        stage: 'domain_match',
        code: 'CONFIG_DOMAIN_MISMATCH',
      }),
    );
  });
});
