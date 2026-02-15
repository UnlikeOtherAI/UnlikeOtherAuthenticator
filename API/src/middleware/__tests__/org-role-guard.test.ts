import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenClaims } from '../../services/access-token.service.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

import { AppError } from '../../utils/errors.js';
import { requireOrgRole } from '../org-role-guard.js';

const verifyAccessTokenMock = vi.fn();

vi.mock('../../services/access-token.service.js', () => {
  return {
    verifyAccessToken: (...args: unknown[]) => verifyAccessTokenMock(...args),
  };
});

function buildClaims(overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims {
  return {
    userId: 'user_1',
    email: 'user@example.com',
    domain: 'client.example.com',
    clientId: 'client-id',
    role: 'user',
    ...overrides,
  };
}

function makeRequest(token: string | null, domain: string) {
  const headers: Record<string, string | undefined> = {};
  if (token !== null) {
    headers['x-uoa-access-token'] = token;
  }

  return {
    headers,
    config: { domain },
  } as unknown as FastifyRequest;
}

describe('requireOrgRole middleware', () => {
  afterEach(() => {
    verifyAccessTokenMock.mockReset();
  });

  it('rejects when token is missing', async () => {
    const middleware = requireOrgRole('admin');
    const request = makeRequest(null, 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'MISSING_ACCESS_TOKEN',
    });
  });

  it('rejects when token verification fails', async () => {
    verifyAccessTokenMock.mockRejectedValueOnce(new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN'));
    const middleware = requireOrgRole('admin');
    const request = makeRequest('bad-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
      message: 'INVALID_ACCESS_TOKEN',
    });
  });

  it('rejects when token domain does not match request domain', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ domain: 'other.example.com' }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'ACCESS_TOKEN_DOMAIN_MISMATCH',
    });
  });

  it('rejects when org claim is missing and roles are required', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims(),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('Bearer valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('rejects when org role is not allowed', async () => {
    verifyAccessTokenMock.mockResolvedValueOnce(
      buildClaims({ org: { org_id: 'org_1', org_role: 'member', teams: [], team_roles: {} } }),
    );
    const middleware = requireOrgRole('admin');
    const request = makeRequest('valid-token', 'client.example.com');

    await expect(middleware(request, {} as FastifyReply)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
      message: 'INSUFFICIENT_ORG_ROLE',
    });
  });

  it('passes with allowed org role', async () => {
    const claims = buildClaims({
      org: { org_id: 'org_1', org_role: 'admin', teams: [], team_roles: {} },
    });
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole('admin', 'owner');
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });

  it('passes when no required roles are configured', async () => {
    const claims = buildClaims();
    verifyAccessTokenMock.mockResolvedValueOnce(claims);
    const middleware = requireOrgRole();
    const request = makeRequest('valid-token', 'client.example.com');

    await middleware(request, {} as FastifyReply);

    expect(request.accessTokenClaims).toEqual(claims);
  });
});
