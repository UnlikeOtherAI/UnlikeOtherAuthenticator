import { vi } from 'vitest';

// Match the normal harness's synthetic partner DNS/fetch seams without its
// local JWKS HTTP server. Only documentation domains may resolve here.
vi.mock('node:dns/promises', async () => ({
  ...await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises'),
  lookup: vi.fn((hostname: string, options?: { all?: boolean }) => {
    if (hostname !== 'example.com' && !hostname.endsWith('.example.com')) {
      throw new Error('Server-free checks require explicitly mocked DNS');
    }
    const resolved = { address: '93.184.216.34', family: 4 };
    return Promise.resolve(options?.all ? [resolved] : resolved);
  }),
}));
vi.mock('undici', async () => ({
  ...await vi.importActual<typeof import('undici')>('undici'),
  fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
}));
