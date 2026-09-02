import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireOrgRole } from '../org-role-guard.js';

const verifySubjectAssertion = vi.fn();
const lockEpoch = vi.fn();
const isEpochMismatch = vi.fn();
const getActiveOrg = vi.fn();

vi.mock('../../services/confidential-token-exchange.service.js', () => ({
  verifyConfidentialSubjectToken: (...args: unknown[]) => verifySubjectAssertion(...args),
}));

vi.mock('../../services/authentication-epoch.service.js', () => ({
  lockAndAssertAuthenticationEpoch: (...args: unknown[]) => lockEpoch(...args),
  isAuthenticationEpochMismatchError: (...args: unknown[]) => isEpochMismatch(...args),
}));

vi.mock('../../services/org-context.service.js', () => ({
  getActiveClientOrgContext: (...args: unknown[]) => getActiveOrg(...args),
}));

const request = (overrides: { accessToken?: string; assertion?: string; teamId?: string } = {}) => {
  const headers: Record<string, string> = {};
  if ('accessToken' in overrides) headers['x-uoa-access-token'] = overrides.accessToken!;
  if ('assertion' in overrides) headers['x-uoa-subject-assertion'] = overrides.assertion!;
  return {
    headers,
    query: { domain: 'api.nessie.works' },
    configJwt: 'verified-nessie-config.jwt',
    config: {
      domain: 'api.nessie.works',
      org_features: { enabled: true, groups_enabled: true, backend_org_management: true },
    },
    params: { orgId: 'org_1', teamId: overrides.teamId ?? 'team_1' },
    adminDb: { user: { findUnique: vi.fn().mockResolvedValue({ email: 'user@example.com' }) } },
  } as unknown as FastifyRequest;
};

afterEach(() => {
  verifySubjectAssertion.mockReset();
  lockEpoch.mockReset();
  isEpochMismatch.mockReset();
  getActiveOrg.mockReset();
});

describe('requireOrgRole — subject assertion user mode', () => {
  it('re-resolves a Nessie assertion into normal claims before applying the required role', async () => {
    verifySubjectAssertion.mockResolvedValueOnce({
      sub: 'user_1', tv: 7, active: { orgId: 'org_1', teamId: 'team_1' },
    });
    lockEpoch.mockResolvedValueOnce({ tokenVersion: 7 });
    getActiveOrg.mockResolvedValueOnce({
      org_id: 'org_1', tenant_slug: 'live-workspace', org_role: 'owner',
      teams: ['team_1'], team_roles: { team_1: 'admin' },
    });
    const input = request({ assertion: 'nessie.subject.assertion' });

    await requireOrgRole('owner')(input, {} as FastifyReply);

    expect(verifySubjectAssertion).toHaveBeenCalledWith({
      subjectToken: 'nessie.subject.assertion',
      configJwt: 'verified-nessie-config.jwt',
      sourceDomain: 'api.nessie.works',
      audience: 'https://authentication.unlikeotherai.com/org',
    });
    expect(lockEpoch).toHaveBeenCalledWith(
      { userId: 'user_1', domain: 'api.nessie.works', credentialEpoch: 7 },
      expect.objectContaining({ prisma: (input as unknown as { adminDb: unknown }).adminDb }),
    );
    expect(getActiveOrg).toHaveBeenCalledWith(
      { userId: 'user_1', domain: 'api.nessie.works', orgId: 'org_1', groupsEnabled: true },
      expect.objectContaining({ prisma: (input as unknown as { adminDb: unknown }).adminDb }),
    );
    expect(input.accessTokenClaims).toMatchObject({
      userId: 'user_1', tokenVersion: 7, email: 'user@example.com',
      org: { org_id: 'org_1', org_role: 'owner' },
      active: { orgId: 'org_1', teamId: 'team_1', tenantSlug: 'live-workspace' },
    });
  });

  it('refuses a mismatched active workspace before any live lookup', async () => {
    verifySubjectAssertion.mockResolvedValueOnce({
      sub: 'user_1', tv: 7, active: { orgId: 'org_1', teamId: 'team_other' },
    });
    await expect(requireOrgRole()(request({ assertion: 'assertion' }), {} as FastifyReply))
      .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403, message: 'INSUFFICIENT_ORG_ROLE' });
    expect(lockEpoch).not.toHaveBeenCalled();
    expect(getActiveOrg).not.toHaveBeenCalled();
  });

  it('refuses a stale credential epoch', async () => {
    verifySubjectAssertion.mockResolvedValueOnce({
      sub: 'user_1', tv: 7, active: { orgId: 'org_1', teamId: 'team_1' },
    });
    lockEpoch.mockRejectedValueOnce(new Error('credential epoch changed'));
    isEpochMismatch.mockReturnValueOnce(true);
    await expect(requireOrgRole()(request({ assertion: 'assertion' }), {} as FastifyReply))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' });
  });

  it.each([
    { accessToken: 'user.access.token', assertion: 'nessie.subject.assertion' },
    { assertion: 'first.assertion, second.assertion' },
  ])('refuses ambiguous or repeated user credentials', async (headers) => {
    await expect(requireOrgRole()(request(headers), {} as FastifyReply))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401, message: 'INVALID_SUBJECT_TOKEN' });
    expect(verifySubjectAssertion).not.toHaveBeenCalled();
  });
});
