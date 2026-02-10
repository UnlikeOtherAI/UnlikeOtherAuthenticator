import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

describe('generic error responses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a generic message for 404 responses', async () => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/this-route-does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});

