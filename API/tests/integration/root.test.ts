import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { createApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';
import { testConfigJwks } from '../helpers/test-config.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
  process.env.AUTH_SERVICE_IDENTIFIER =
    process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /', () => {
  it('returns a Tailwind holding page linking to Admin, LLM docs, and API schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Unlike Other Authenticator');
    expect(res.body).toContain('class="');
    expect(res.body).toContain('href="/admin"');
    expect(res.body).toContain('href="/llm"');
    expect(res.body).toContain('href="/api"');
  });

  it('returns no-store headers for the holding page', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['cache-control']).toContain('no-store');
  });
});

describe('GET /api', () => {
  it('returns API information with version, repo link, config docs, and endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api' });

    expect(res.statusCode).toBe(200);

    const body = res.json();

    expect(body.name).toBe('UnlikeOtherAuthenticator');
    expect(body.description).toEqual(expect.any(String));
    expect(body.version).toEqual(expect.any(String));
    expect(body.repository).toBe(
      'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
    );
    expect(body.home).toBe('/');
    expect(body.api).toBe('/api');
    expect(body.config_jwt.required_fields.ui_theme.required_sections.colors.required_keys).toContain(
      'primary',
    );
    expect(body.config_validation.path).toBe('/config/validate');
    expect(body.config_verification.path).toBe('/config/verify');
    expect(body.endpoints).toEqual(expect.any(Array));
    expect(body.endpoints.length).toBeGreaterThan(0);

    // Every endpoint entry has the expected shape
    for (const ep of body.endpoints) {
      expect(ep).toEqual(
        expect.objectContaining({
          method: expect.any(String),
          path: expect.any(String),
          description: expect.any(String),
        }),
      );
    }

    // The root holding page and API schema endpoint are listed
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/api' }),
    );

    // Spot-check well-known routes with correct methods and paths
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/health' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/.well-known/jwks.json' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/config/verify' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/config/validate' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/auth/login' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/auth/callback/:provider' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/auth/social/:provider' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/auth/reset-password/request' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/auth/email/twofa-reset/confirm' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/2fa/verify' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/org/me' }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/org/organisations/:orgId/teams/:teamId/invitations',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/org/organisations/:orgId/teams/:teamId/access-requests',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/org/organisations/:orgId/teams/:teamId/access-requests/:requestId/approve',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/internal/admin/token',
        auth: expect.stringContaining('PKCE'),
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/internal/admin/dashboard',
        auth: expect.stringContaining('superuser'),
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/internal/admin/handshake-errors',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/integrations/claim/:token',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/integrations/claim/:token/confirm',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/internal/admin/integration-requests',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/internal/admin/integration-requests/:id/accept',
      }),
    );
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/internal/admin/domains/:domain/jwks',
      }),
    );
  });

  it('returns a valid semver-like version string from package.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api' });
    const body = res.json();

    // Version should match the pattern from package.json (digits.digits.digits with optional pre-release)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns correct content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api' });

    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('serves the configured public JWKS without private key material', async () => {
    const originalJwksJson = process.env.CONFIG_JWKS_JSON;
    process.env.CONFIG_JWKS_JSON = JSON.stringify(await testConfigJwks());

    try {
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      const body = res.json();

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toContain('max-age=300');
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0]).toEqual(
        expect.objectContaining({
          kty: 'RSA',
          kid: expect.any(String),
          n: expect.any(String),
          e: expect.any(String),
        }),
      );
      expect(body.keys[0]).not.toHaveProperty('d');
      expect(body.keys[0]).not.toHaveProperty('p');
      expect(body.keys[0]).not.toHaveProperty('q');
    } finally {
      if (originalJwksJson === undefined) {
        Reflect.deleteProperty(process.env, 'CONFIG_JWKS_JSON');
      } else {
        process.env.CONFIG_JWKS_JSON = originalJwksJson;
      }
    }
  });

  it('rejects configured JWKS values that contain private key material', async () => {
    const originalJwksJson = process.env.CONFIG_JWKS_JSON;
    process.env.CONFIG_JWKS_JSON = JSON.stringify({
      keys: [{ kty: 'RSA', kid: 'private', n: 'abc', e: 'AQAB', d: 'secret' }],
    });

    try {
      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });

      expect(res.statusCode).toBe(500);
      expect(String(res.headers['cache-control'] ?? '')).not.toContain('max-age=300');
    } finally {
      if (originalJwksJson === undefined) {
        Reflect.deleteProperty(process.env, 'CONFIG_JWKS_JSON');
      } else {
        process.env.CONFIG_JWKS_JSON = originalJwksJson;
      }
    }
  });
});

describe('GET /llm', () => {
  it('returns Markdown instructions and links JSON consumers to /api', async () => {
    const res = await app.inject({ method: 'GET', url: '/llm' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('# UnlikeOtherAuthenticator integration guide');
    expect(res.body).toContain('For machine-readable JSON');
    expect(res.body).toContain('[/api](/api)');
    expect(res.body).toContain('POST /config/validate');
    expect(res.body).toContain('POST /config/verify');
    expect(res.body).toContain('/.well-known/jwks.json');
    expect(res.body).toContain('/internal/admin/token');
    expect(res.body).toContain('allow_registration');
    expect(res.body).toContain('Auto-onboard with one');
    expect(res.body).toContain('jwks_url');
    expect(res.body).toContain('contact_email');
    expect(res.body).toContain('INTEGRATION_JWKS_HOST_MISMATCH');
  });
});
