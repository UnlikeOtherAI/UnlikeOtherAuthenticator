import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchConfigJwtFromUrl } from '../../src/services/config-fetch.service.js';

describe('fetchConfigJwtFromUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects private IP config URLs before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl('https://127.0.0.1/config')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses manual redirects and revalidates each redirect target', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'https://127.0.0.1/config' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl('https://client.example.com/config')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: expect.any(Object),
      redirect: 'manual',
    });
  });

  it('pins a validated dispatcher for each redirect hop', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { location: 'https://next.example.com/config' },
        }),
      )
      .mockResolvedValueOnce(new Response('config.jwt.value', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl('https://client.example.com/config')).resolves.toBe(
      'config.jwt.value',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: expect.any(Object),
      redirect: 'manual',
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      dispatcher: expect.any(Object),
      redirect: 'manual',
    });
  });
});
