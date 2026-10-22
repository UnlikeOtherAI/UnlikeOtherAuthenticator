import { afterAll, beforeAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { randomBytes } from 'node:crypto';

import { testConfigJwks } from './helpers/test-config.js';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');

  return {
    ...actual,
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
  };
});

vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>(
    'node:dns/promises',
  );

  return {
    ...actual,
    lookup: vi.fn((hostname: string, options?: { all?: boolean }) => {
      if (hostname === 'example.com' || hostname.endsWith('.example.com')) {
        const resolved = { address: '93.184.216.34', family: 4 };
        return Promise.resolve(options?.all ? [resolved] : resolved);
      }

      return actual.lookup(hostname, options);
    }),
  };
});

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.SHARED_SECRET =
  process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
process.env.AUTH_SERVICE_IDENTIFIER =
  process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
process.env.ADMIN_ACCESS_TOKEN_SECRET =
  process.env.ADMIN_ACCESS_TOKEN_SECRET ?? 'test-admin-token-secret-with-enough-length';

// Fresh confidential authentication now exercises real encrypted proof custody.
// This isolated test-only key is never a production/default custody fallback.
process.env.ENTERPRISE_SSO_CUSTODY_PROVIDER ??= 'local';
process.env.ENTERPRISE_SSO_KEYRING ??= JSON.stringify({ current: 'vitest', keys: { vitest: randomBytes(32).toString('base64') } });

let jwksServer: Server | undefined;

beforeAll(async () => {
  const jwks = await testConfigJwks();

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jwks));
  });

  await new Promise<void>((resolve) => {
    jwksServer!.listen(0, '127.0.0.1', resolve);
  });

  const address = jwksServer.address() as AddressInfo;
  process.env.CONFIG_JWKS_URL = `http://127.0.0.1:${address.port}/jwks.json`;
});

afterAll(async () => {
  if (!jwksServer) return;

  await new Promise<void>((resolve, reject) => {
    jwksServer!.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});
