import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, createApiClient } from './api-client';

const origin = 'https://admin.example.com';
const fetchMock = vi.fn();
const sessionStorage = {
  getItem: vi.fn(() =>
    JSON.stringify({ accessToken: 'admin-access-token', expiresAt: Date.now() + 60_000 }),
  ),
  removeItem: vi.fn(),
  setItem: vi.fn(),
};

describe('Admin API client binary transport', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin }, sessionStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads multipart without overriding the browser-generated content type', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'version-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const form = new FormData();
    form.set('file', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'terms.pdf');

    await expect(
      createApiClient(origin).postForm<{ id: string }>('/upload', form),
    ).resolves.toEqual({
      id: 'version-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.toString()).toBe(`${origin}/upload`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(form);
    expect(headers.get('Authorization')).toBe('Bearer admin-access-token');
    expect(headers.get('Content-Type')).toBeNull();
  });

  it('requests private PDF bytes with the admin bearer token', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Blob(['%PDF-receipt'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );

    const blob = await createApiClient(origin).getBlob('/receipt');
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(await blob.text()).toBe('%PDF-receipt');
    expect(headers.get('Accept')).toBe('application/pdf');
    expect(headers.get('Authorization')).toBe('Bearer admin-access-token');
  });

  it('refuses to send the admin bearer to a cross-origin API', async () => {
    await expect(
      createApiClient('https://attacker.example').get('/internal/admin/session'),
    ).rejects.toThrow('Cross-origin admin API requests are not permitted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the HTTP status for callers that distinguish absence from read failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(createApiClient(origin).get('/missing')).rejects.toEqual(
      expect.objectContaining<ApiRequestError>({
        name: 'ApiRequestError',
        message: 'Request failed with HTTP 404',
        status: 404,
      }),
    );
  });
});
