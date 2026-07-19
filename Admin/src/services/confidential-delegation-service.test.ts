import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confidentialDelegationService } from './confidential-delegation-service';

const origin = 'https://authentication.unlikeotherai.com';
const fetchMock = vi.fn();
const sessionStorage = {
  getItem: vi.fn(() =>
    JSON.stringify({ accessToken: 'admin-access-token', expiresAt: Date.now() + 60_000 }),
  ),
  removeItem: vi.fn(),
  setItem: vi.fn(),
};

const mapping = {
  id: 'mapping-1',
  source_domain: 'api.deepwater.live',
  product: 'deepwater',
  resource: 'https://ledger.unlikeotherai.com',
  scopes: ['ai.invoke'],
  enabled: true,
  created_by_email: 'operator@example.com',
  updated_by_email: 'operator@example.com',
  created_at: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('confidential delegation admin client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sessionStorage.getItem.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { origin }, sessionStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists mappings with the signed-in admin bearer and validates the response', async () => {
    fetchMock.mockResolvedValue(jsonResponse([mapping]));

    await expect(confidentialDelegationService.list()).resolves.toEqual([mapping]);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${origin}/internal/admin/confidential-delegations`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer admin-access-token');
  });

  it('creates the exact snake-case policy payload without exposing credentials', async () => {
    fetchMock.mockResolvedValue(jsonResponse(mapping, 201));

    await confidentialDelegationService.create({
      sourceDomain: 'api.deepwater.live',
      product: 'deepwater',
      resource: 'https://ledger.unlikeotherai.com',
      scopes: ['ai.invoke'],
      enabled: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      source_domain: 'api.deepwater.live',
      product: 'deepwater',
      resource: 'https://ledger.unlikeotherai.com',
      scopes: ['ai.invoke'],
      enabled: true,
    });
    expect(String(init.body)).not.toContain('access-token');
  });

  it('patches only mutable fields and safely encodes the mapping id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...mapping, enabled: false }));

    await confidentialDelegationService.update('mapping/1', { enabled: false });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${origin}/internal/admin/confidential-delegations/mapping%2F1`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('rejects malformed server responses instead of rendering them', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...mapping, scopes: ['root'] }]));

    await expect(confidentialDelegationService.list()).rejects.toThrow();
  });

  it('deletes through the authenticated same-origin client', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await confidentialDelegationService.remove('mapping-1');

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${origin}/internal/admin/confidential-delegations/mapping-1`);
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer admin-access-token');
  });
});
