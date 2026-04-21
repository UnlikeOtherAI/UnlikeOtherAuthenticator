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
  response: { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string },
  params: { statusCode: number; code: string; summary: string },
): void {
  expect(response.statusCode).toBe(params.statusCode);
  expect(response.headers['content-type']).toContain('text/html');
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

  afterEach(() => {
    restoreEnv('DEBUG_ENABLED', originalDebugEnabled);
  });

  it('renders rich auth HTML for Zod errors when DEBUG_ENABLED is false', async () => {
    process.env.DEBUG_ENABLED = 'false';
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

  it('renders rich auth HTML for AppError errors when DEBUG_ENABLED is false', async () => {
    process.env.DEBUG_ENABLED = 'false';
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

  it('renders rich auth HTML for unknown errors when DEBUG_ENABLED is false', async () => {
    process.env.DEBUG_ENABLED = 'false';
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
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('<h1>Request failed</h1>');
      expect(response.body).not.toContain('Auth configuration error');
      expect(response.body).not.toContain(rawUnknownErrorMessage);
    } finally {
      await app.close();
    }
  });
});
