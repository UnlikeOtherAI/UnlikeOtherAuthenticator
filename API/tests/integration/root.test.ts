import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { createApp } from '../../src/app.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
  process.env.AUTH_SERVICE_IDENTIFIER =
    process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

  app = await createApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /', () => {
  it('returns API information with version, repo link, and endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);

    const body = res.json();

    expect(body.name).toBe('UnlikeOtherAuthenticator');
    expect(body.description).toEqual(expect.any(String));
    expect(body.version).toEqual(expect.any(String));
    expect(body.repository).toBe(
      'https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator',
    );
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

    // The root endpoint itself is listed
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/' }),
    );

    // Spot-check well-known routes with correct methods and paths
    expect(body.endpoints).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/health' }),
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
  });

  it('does not expose internal admin routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    const body = res.json();

    const hasInternal = body.endpoints.some(
      (ep: { path: string }) => ep.path.startsWith('/internal'),
    );
    expect(hasInternal).toBe(false);
  });

  it('returns a valid semver-like version string from package.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    const body = res.json();

    // Version should match the pattern from package.json (digits.digits.digits with optional pre-release)
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns correct content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('GET /llm', () => {
  it('documents access request config and backend review endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/llm' });

    expect(res.statusCode).toBe(200);

    const body = res.json();

    expect(body.config_jwt.optional_fields.access_requests.fields.target_team_id).toContain(
      'team that receives auto-grants and access requests',
    );
    expect(body.integration_guide.step_10).toContain('request_access=true');
    expect(body.integration_guide.step_12).toContain('/teams/:teamId/access-requests');
    expect(body.integration_guide.step_13).toContain('optional slug');
  });
});
