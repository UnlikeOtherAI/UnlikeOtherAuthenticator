import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPartnerJwks } from '../../src/services/jwks-fetch.service.js';

const publicJwk = {
  kty: 'RSA',
  kid: 'partner-2026-04',
  alg: 'RS256',
  use: 'sig',
  n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6Bbq1B4N7yU5I9kNbGzrR1_IcpbhM0TbBTpxKfjvCT0e8VXUW1WPbSgpS2Mx7Zd8fX3h7uXXHYPtvDlJZ6JZPoz0lJj8t3Lb4',
  e: 'AQAB',
};

describe('fetchPartnerJwks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects private IP JWKS URLs before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPartnerJwks('https://127.0.0.1/.well-known/jwks.json')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS JWKS URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPartnerJwks('http://client.example.com/jwks.json')).rejects.toMatchObject({
      statusCode: 400,
      message: 'INTEGRATION_JWKS_URL_INVALID',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns parsed JWKS on 200 OK', async () => {
    const body = JSON.stringify({ keys: [publicJwk] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const jwks = await fetchPartnerJwks('https://client.example.com/.well-known/jwks.json');
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe('partner-2026-04');
  });

  it('rejects JWKS containing private key material', async () => {
    const body = JSON.stringify({ keys: [{ ...publicJwk, d: 'leaked-private' }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPartnerJwks('https://client.example.com/.well-known/jwks.json'),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-JSON body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('not-json', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPartnerJwks('https://client.example.com/.well-known/jwks.json'),
    ).rejects.toMatchObject({ statusCode: 400, message: 'INTEGRATION_JWKS_NOT_JSON' });
  });

  it('rejects HTTP error statuses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPartnerJwks('https://client.example.com/.well-known/jwks.json'),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'INTEGRATION_JWKS_HTTP_STATUS_REJECTED',
    });
  });

  it('re-validates redirect targets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://127.0.0.1/jwks.json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPartnerJwks('https://client.example.com/.well-known/jwks.json'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
