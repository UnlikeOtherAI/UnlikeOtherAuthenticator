import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  requireDomainHashAuth,
  requireDomainHashAuthForDomainQuery,
} from '../domain-hash-auth.js';

function domainHash(domain: string, secret: string): string {
  return createHash('sha256').update(`${domain}${secret}`).digest('hex');
}

function makeRequest(params: {
  authorizationDomain: string;
  configDomain?: string;
  queryDomain?: string;
  sharedSecret: string;
}): FastifyRequest {
  const query =
    params.queryDomain === undefined
      ? {}
      : {
          domain: params.queryDomain,
        };

  return {
    headers: {
      authorization: `Bearer ${domainHash(params.authorizationDomain, params.sharedSecret)}`,
    },
    query,
    config: params.configDomain ? { domain: params.configDomain } : undefined,
  } as unknown as FastifyRequest;
}

describe('domain hash auth middleware', () => {
  const originalSharedSecret = process.env.SHARED_SECRET;
  const sharedSecret = 'test-shared-secret-with-enough-length';

  afterEach(() => {
    process.env.SHARED_SECRET = originalSharedSecret;
  });

  it('uses the verified config domain for post-config auth', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    const request = makeRequest({
      authorizationDomain: 'client.example.com',
      configDomain: 'client.example.com',
      queryDomain: 'attacker.example.com',
      sharedSecret,
    });

    await expect(requireDomainHashAuth(request)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('accepts a matching query domain on post-config auth', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    const request = makeRequest({
      authorizationDomain: 'client.example.com',
      configDomain: 'client.example.com',
      queryDomain: 'client.example.com',
      sharedSecret,
    });

    await expect(requireDomainHashAuth(request)).resolves.toBeUndefined();
  });

  it('keeps the domain-query helper query-first for domain scoped routes', async () => {
    process.env.SHARED_SECRET = sharedSecret;
    const request = makeRequest({
      authorizationDomain: 'attacker.example.com',
      configDomain: 'client.example.com',
      queryDomain: 'attacker.example.com',
      sharedSecret,
    });

    await expect(requireDomainHashAuthForDomainQuery(request)).resolves.toBeUndefined();
  });
});
