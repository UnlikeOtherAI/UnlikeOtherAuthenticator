import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requireDomainHashAuth,
  requireDomainHashAuthForDomainQuery,
} from '../domain-hash-auth.js';
import { verifyDomainAuthToken } from '../../services/domain-secret.service.js';

vi.mock('../../services/domain-secret.service.js', () => ({
  verifyDomainAuthToken: vi.fn(async ({ domain, token }: { domain: string; token: string }) => ({
    clientId: token,
    domain,
    hashPrefix: token.slice(0, 12),
  })),
}));

const verifyDomainAuthTokenMock = vi.mocked(verifyDomainAuthToken);

function makeRequest(params: {
  configDomain?: string;
  queryDomain?: string;
  token?: string;
}): FastifyRequest {
  const query =
    params.queryDomain === undefined
      ? {}
      : {
          domain: params.queryDomain,
        };

  return {
    headers: {
      authorization: `Bearer ${params.token ?? 'a'.repeat(64)}`,
    },
    query,
    config: params.configDomain ? { domain: params.configDomain } : undefined,
  } as unknown as FastifyRequest;
}

describe('domain hash auth middleware', () => {
  beforeEach(() => {
    verifyDomainAuthTokenMock.mockClear();
  });

  it('uses the verified config domain for post-config auth', async () => {
    const request = makeRequest({
      configDomain: 'client.example.com',
      queryDomain: 'attacker.example.com',
    });

    await expect(requireDomainHashAuth(request)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
    expect(verifyDomainAuthTokenMock).not.toHaveBeenCalled();
  });

  it('accepts a matching query domain on post-config auth', async () => {
    const request = makeRequest({
      configDomain: 'client.example.com',
      queryDomain: 'client.example.com',
    });

    await expect(requireDomainHashAuth(request)).resolves.toBeUndefined();
    expect(verifyDomainAuthTokenMock).toHaveBeenCalledWith({
      domain: 'client.example.com',
      token: 'a'.repeat(64),
    });
    expect(request.domainAuthClientId).toBe('a'.repeat(64));
  });

  it('keeps the domain-query helper query-first for domain scoped routes', async () => {
    const request = makeRequest({
      configDomain: 'client.example.com',
      queryDomain: 'attacker.example.com',
      token: 'b'.repeat(64),
    });

    await expect(requireDomainHashAuthForDomainQuery(request)).resolves.toBeUndefined();
    expect(verifyDomainAuthTokenMock).toHaveBeenCalledWith({
      domain: 'attacker.example.com',
      token: 'b'.repeat(64),
    });
  });
});
