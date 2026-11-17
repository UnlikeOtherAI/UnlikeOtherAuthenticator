import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchConfigJwtFromUrl } from '../../src/services/config-fetch.service.js';

const jwt = 'header.payload.signature';
const dispatcherOf = (call: unknown[]): unknown =>
  (call[1] as { dispatcher?: unknown } | undefined)?.dispatcher;

describe('config fetch over a kept connection', () => {
  beforeEach(() => {
    vi.stubEnv('CONFIG_FETCH_KEEP_ALIVE_SECONDS', '30');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('still fetches for every call, and reuses one agent per host', async () => {
    const fetchMock = vi.fn(async () => new Response(jwt));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfigJwtFromUrl('https://kept-a.example.com/config')).resolves.toBe(jwt);
    await fetchConfigJwtFromUrl('https://kept-a.example.com/config');
    await fetchConfigJwtFromUrl('https://kept-b.example.com/config');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [first, second, otherHost] = fetchMock.mock.calls.map(dispatcherOf);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(otherHost).not.toBe(first);
  });

  it('asks again on a new connection when a kept one fails, once', async () => {
    const fetchMock = vi.fn(async () => new Response(jwt));
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://kept-retry.example.com/config';
    await fetchConfigJwtFromUrl(url);

    fetchMock.mockRejectedValueOnce(new TypeError('other side closed'));
    await expect(fetchConfigJwtFromUrl(url)).resolves.toBe(jwt);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [kept, failed, repeated] = fetchMock.mock.calls.map(dispatcherOf);
    expect(failed).toBe(kept);
    expect(repeated).not.toBe(kept);

    // A product that is really unreachable is a network error after the one repeat.
    fetchMock
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockRejectedValueOnce(new TypeError('connection refused'));
    await expect(fetchConfigJwtFromUrl(url)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not repeat a fetch that ran out of time', async () => {
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchConfigJwtFromUrl('https://kept-slow.example.com/config', { timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens a connection per fetch and repeats nothing when keeping is off', async () => {
    vi.stubEnv('CONFIG_FETCH_KEEP_ALIVE_SECONDS', '0');
    const fetchMock = vi.fn(async () => new Response(jwt));
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://kept-off.example.com/config';

    await fetchConfigJwtFromUrl(url);
    await fetchConfigJwtFromUrl(url);
    const [first, second] = fetchMock.mock.calls.map(dispatcherOf);
    expect(second).not.toBe(first);

    fetchMock.mockRejectedValueOnce(new TypeError('connection refused'));
    await expect(fetchConfigJwtFromUrl(url)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
