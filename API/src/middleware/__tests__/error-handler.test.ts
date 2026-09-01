import fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../utils/errors.js';
import { registerErrorHandler } from '../error-handler.js';

const rawUnknownErrorMessage = 'raw database password leaked';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function expectRichAuthHtml(
  response: { statusCode: number; headers: Record<string, unknown>; body: string },
  params: { statusCode: number; code: string; summary: string },
): void {
  expect(response.statusCode).toBe(params.statusCode);
  expect(String(response.headers['content-type'])).toContain('text/html');
  expect(response.body).toContain('Auth configuration error');
  expect(response.body).toContain(`<span class="chip">${params.code}</span>`);
  expect(response.body).toContain('<h2>Summary</h2>');
  expect(response.body).toContain(params.summary);
  expect(response.body).not.toContain('<h1>Request failed</h1>');
}

async function createErrorTestApp() {
  const app = fastify({ logger: false });
  registerErrorHandler(app);

  app.get('/auth/zod-error', () => {
    z.object({ config_url: z.string().min(1) }).parse({});
  });

  app.get('/auth/app-error', () => {
    throw new AppError('BAD_REQUEST', 400, 'REDIRECT_URL_NOT_ALLOWED');
  });

  app.get('/auth/public-app-error', () => {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_TOKEN');
  });

  app.get('/auth/message-app-error', () => {
    throw new AppError('BAD_REQUEST', 400, 'Redirect url is not allowed.');
  });

  app.get('/auth/unknown-error', () => {
    throw new Error(rawUnknownErrorMessage);
  });

  app.get('/api/unknown-error', () => {
    throw new Error(rawUnknownErrorMessage);
  });

  app.get('/not-auth/unknown-error', () => {
    throw new Error(rawUnknownErrorMessage);
  });

  await app.ready();
  return app;
}

describe('error handler auth HTML rendering', () => {
  const originalDebugEnabled = process.env.DEBUG_ENABLED;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSharedSecret = process.env.SHARED_SECRET;

  afterEach(() => {
    restoreEnv('DEBUG_ENABLED', originalDebugEnabled);
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('SHARED_SECRET', originalSharedSecret);
  });

  // The rich diagnostic page is an operator aid gated on DEBUG_ENABLED — the
  // same flag that unlocks the debug JSON body — so anonymous HTML callers on
  // /auth* never see the redirect allowlist, Zod issues, or config example.
  describe('rich auth HTML when DEBUG_ENABLED is true', () => {
    it('renders rich auth HTML for Zod errors', async () => {
      process.env.DEBUG_ENABLED = 'true';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/zod-error',
          headers: { accept: 'text/html' },
        });

        expectRichAuthHtml(response, {
          statusCode: 400,
          code: 'AUTH_REQUEST_INVALID',
          summary: 'The auth request query could not be parsed.',
        });
        expect(response.body).toContain('config_url');
      } finally {
        await app.close();
      }
    });

    it('renders rich auth HTML for AppError errors', async () => {
      process.env.DEBUG_ENABLED = 'true';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/app-error',
          headers: { accept: 'text/html' },
        });

        expectRichAuthHtml(response, {
          statusCode: 400,
          code: 'REDIRECT_URL_NOT_ALLOWED',
          summary: 'The requested redirect_url is not allowed for this client config.',
        });
      } finally {
        await app.close();
      }
    });

    it('renders rich auth HTML for unknown errors', async () => {
      process.env.DEBUG_ENABLED = 'true';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/unknown-error',
          headers: { accept: 'text/html' },
        });

        expectRichAuthHtml(response, {
          statusCode: 500,
          code: 'AUTH_REQUEST_FAILED',
          summary: 'The auth service could not complete this request.',
        });
        expect(response.body).not.toContain(rawUnknownErrorMessage);
      } finally {
        await app.close();
      }
    });
  });

  it('keeps non-auth JSON errors on the public generic response path', async () => {
    process.env.DEBUG_ENABLED = 'false';
    const app = await createErrorTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/unknown-error',
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Request failed' });
    } finally {
      await app.close();
    }
  });

  it('uses the generic HTML fallback outside auth requests', async () => {
    process.env.DEBUG_ENABLED = 'false';
    const app = await createErrorTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/not-auth/unknown-error',
        headers: { accept: 'text/html' },
      });

      expect(response.statusCode).toBe(500);
      expect(String(response.headers['content-type'])).toContain('text/html');
      expect(response.body).toContain('<h1>Request failed</h1>');
      expect(response.body).not.toContain('Auth configuration error');
      expect(response.body).not.toContain(rawUnknownErrorMessage);
    } finally {
      await app.close();
    }
  });

  describe('generic auth HTML when DEBUG_ENABLED is false', () => {
    it('serves the generic page for Zod errors with the error code only', async () => {
      process.env.DEBUG_ENABLED = 'false';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/zod-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(400);
        expect(String(response.headers['content-type'])).toContain('text/html');
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).not.toContain('<code>');
        expect(response.body).not.toContain('AUTH_REQUEST_INVALID');
        expect(response.body).not.toContain('Auth configuration error');
        expect(response.body).not.toContain('config_url');
        expect(response.body).not.toContain('Allowlisted redirect_urls');
        expect(response.body).not.toContain('Full config example');
      } finally {
        await app.close();
      }
    });

    it('withholds a non-public AppError code with DEBUG_ENABLED off', async () => {
      process.env.DEBUG_ENABLED = 'false';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/app-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).not.toContain('<code>');
        expect(response.body).not.toContain('REDIRECT_URL_NOT_ALLOWED');
        expect(response.body).not.toContain('Auth configuration error');
        expect(response.body).not.toContain('Allowlisted redirect_urls');
      } finally {
        await app.close();
      }
    });

    it('shows a publicly-exposable AppError code with DEBUG_ENABLED off', async () => {
      process.env.DEBUG_ENABLED = 'false';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/public-app-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(401);
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).toContain('<code>INVALID_TOKEN</code>');
        expect(response.body).not.toContain('Auth configuration error');
      } finally {
        await app.close();
      }
    });

    it('never renders a non-code-shaped AppError message as a code', async () => {
      process.env.DEBUG_ENABLED = 'false';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/message-app-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).not.toContain('<code>');
        expect(response.body).not.toContain('Redirect url is not allowed.');
        expect(response.body).not.toContain('Auth configuration error');
      } finally {
        await app.close();
      }
    });

    it('serves the generic page for unknown errors without the raw message', async () => {
      process.env.DEBUG_ENABLED = 'false';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/unknown-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(500);
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).not.toContain('Auth configuration error');
        expect(response.body).not.toContain('<code>');
        expect(response.body).not.toContain(rawUnknownErrorMessage);
      } finally {
        await app.close();
      }
    });

    it('serves the generic page in production even with an Accept: text/html header', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DEBUG_ENABLED = 'false';
      // Production env validation requires a longer SHARED_SECRET.
      process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length-for-production';
      const app = await createErrorTestApp();

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/auth/zod-error',
          headers: { accept: 'text/html' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toContain('<h1>Request failed</h1>');
        expect(response.body).not.toContain('<code>');
        expect(response.body).not.toContain('AUTH_REQUEST_INVALID');
        expect(response.body).not.toContain('Auth configuration error');
        expect(response.body).not.toContain('config_url');
        expect(response.body).not.toContain('Allowlisted redirect_urls');
        expect(response.body).not.toContain('Full config example');
      } finally {
        await app.close();
      }
    });
  });
});
