import { afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { testConfigJwks } from './helpers/test-config.js';

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.SHARED_SECRET =
  process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
process.env.AUTH_SERVICE_IDENTIFIER =
  process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';

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
