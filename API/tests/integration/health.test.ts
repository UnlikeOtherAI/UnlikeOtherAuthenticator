import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  it('returns ok', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });
});
