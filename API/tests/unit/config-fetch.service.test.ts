import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';

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

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:0a00:1',
    '::ffff:c0a8:1',
    '::ffff:a9fe:1',
  ])('rejects blocked IPv4-mapped IPv6 config URLs (%s)', async (address) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl(`https://[${address}]/config`)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows public IPv4-mapped IPv6 config URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('config.jwt.value', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl('https://[::ffff:8.8.8.8]/config')).resolves.toBe(
      'config.jwt.value',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    '64:ff9b::a00:1',
    '64:ff9b::c0a8:1',
    '64:ff9b::8.8.8.8',
    '64:ff9b:1::1',
    '64:ff9b:1:abc::1',
    'ff02::1',
  ])('rejects blocked IPv6 config URLs (%s)', async (address) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl(`https://[${address}]/config`)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
  ])('rejects expanded loopback IPv6 DNS results (%s)', async (address) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(lookup).mockResolvedValueOnce([{ address, family: 6 }]);

    await expect(fetchConfigJwtFromUrl('https://loopback.example.test/config')).rejects.toMatchObject(
      {
        statusCode: 400,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['2001:db8::1', '64:ff9c::1'])(
    'allows unblocked IPv6 config URLs (%s)',
    async (address) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('config.jwt.value', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchConfigJwtFromUrl(`https://[${address}]/config`)).resolves.toBe(
        'config.jwt.value',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

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
