import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';

describe('GET /auth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches config JWT from config_url and returns ok', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const fetchMock = vi.fn().mockResolvedValue(new Response('test.jwt.token', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const app = await createApp();
    await app.ready();

    const configUrl = 'https://client.example.com/auth-config';
    const res = await app.inject({
      method: 'GET',
      url: `/auth?config_url=${encodeURIComponent(configUrl)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(configUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: 'GET',
      }),
    );

    await app.close();
  });

  it('returns generic 400 when config_url is missing', async () => {
    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';

    const app = await createApp();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/auth' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Request failed' });

    await app.close();
  });
});
