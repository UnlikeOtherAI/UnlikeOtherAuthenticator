import fastify, { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { AppError } from '../../src/utils/errors.js';

const mocks = vi.hoisted(() => ({
  access: vi.fn(), assertion: vi.fn(), context: vi.fn(), epoch: vi.fn(),
  list: vi.fn(), get: vi.fn(), resend: vi.fn(), tenant: vi.fn(),
  prisma: {
    organisation: { findFirst: vi.fn() },
    orgMember: { findFirst: vi.fn() },
    teamMember: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const config = {
  domain: 'product.example.com',
  org_features: { enabled: true, backend_org_management: true },
} as ClientConfig;

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), DATABASE_URL: 'postgresql://example.invalid/test' }),
  };
});

vi.mock('../../src/middleware/domain-hash-auth.js', () => ({
  default: () => async (request: FastifyRequest) => {
    request.domainAuthClientDomainId = 'domain-1';
  },
}));
vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: FastifyRequest) => {
    request.config = config;
    request.configJwt = 'verified-config';
    request.configUrl = 'https://product.example.com/config';
  },
}));
vi.mock('../../src/services/access-token.service.js', () => ({
  verifyAccessToken: (...args: unknown[]) => mocks.access(...args),
}));
vi.mock('../../src/services/confidential-token-exchange.service.js', () => ({
  verifyConfidentialSubjectToken: (...args: unknown[]) => mocks.assertion(...args),
}));
vi.mock('../../src/services/authentication-epoch.service.js', () => ({
  lockAndAssertAuthenticationEpoch: (...args: unknown[]) => mocks.epoch(...args),
  isAuthenticationEpochMismatchError: () => false,
}));
vi.mock('../../src/services/org-context.service.js', () => ({
  getActiveClientOrgContext: (...args: unknown[]) => mocks.context(...args),
}));
vi.mock('../../src/services/team-invite.service.js', () => ({
  listTeamInvites: (...args: unknown[]) => mocks.list(...args),
  getTeamInvite: (...args: unknown[]) => mocks.get(...args),
  resendTeamInvite: (...args: unknown[]) => mocks.resend(...args),
}));
vi.mock('../../src/plugins/tenant-context.plugin.js', () => ({
  setTenantContextFromRequest: (...args: unknown[]) => mocks.tenant(...args),
}));

const endpoints = [
  { method: 'GET', suffix: '', service: mocks.list },
  { method: 'GET', suffix: '/invite-1', service: mocks.get },
  { method: 'POST', suffix: '/invite-1/resend', service: mocks.resend },
] as const;

async function call(
  endpoint: (typeof endpoints)[number],
  headers: Record<string, string> = { 'x-uoa-subject-assertion': 'subject' },
) {
  const { registerTeamInvitationRoutes } = await import('../../src/routes/org/team-invitations.js');
  const app = fastify();
  app.decorateRequest('withTenantTx', null);
  app.decorate('adminDb', mocks.prisma);
  app.addHook('onRequest', async (request) => {
    request.adminDb = mocks.prisma as never;
    request.withTenantTx = async (callback) => callback(mocks.prisma as never);
  });
  registerTeamInvitationRoutes(app);
  try {
    return await app.inject({
      method: endpoint.method,
      url: `/org/organisations/org-1/teams/team-1/invitations${endpoint.suffix}`
        + '?domain=product.example.com&config_url=https%3A%2F%2Fproduct.example.com%2Fconfig',
      headers,
    });
  } finally {
    await app.close();
  }
}

describe.each(endpoints)('$method invitations$suffix authorization', (endpoint) => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.org_features!.backend_org_management = true;
    delete config.org_features!.role_grants;
    mocks.prisma.organisation.findFirst.mockResolvedValue({ id: 'org-1', domain: config.domain });
    mocks.prisma.orgMember.findFirst.mockResolvedValue({ id: 'om-1', role: 'member' });
    mocks.prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'admin' });
    mocks.prisma.user.findUnique.mockResolvedValue({ email: 'actor@example.com' });
    mocks.assertion.mockResolvedValue({
      sub: 'actor-1', tv: 1, active: { orgId: 'org-1', teamId: 'session-team' },
    });
    mocks.epoch.mockResolvedValue({ tokenVersion: 1 });
    mocks.context.mockResolvedValue({
      org_id: 'org-1', org_role: 'member', teams: ['session-team'], tenant_slug: 'org',
    });
    mocks.access.mockResolvedValue({
      userId: 'actor-1', domain: config.domain,
      org: { org_id: 'org-1', org_role: 'owner' },
    });
    endpoint.service.mockResolvedValue({ ok: true });
  });

  it('authorizes a subject assertion against the target team, independent of session team', async () => {
    expect((await call(endpoint)).statusCode).toBe(200);
    expect(mocks.prisma.teamMember.findFirst).toHaveBeenCalledWith({
      where: { teamId: 'team-1', userId: 'actor-1', status: 'ACTIVE' },
      select: { teamRole: true },
    });
    expect(mocks.tenant).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-1', userId: 'actor-1',
    });
    expect(endpoint.service).toHaveBeenCalledOnce();
  });

  it.each(['member', 'unknown'])('refuses an unprivileged %s before reading or emailing', async (role) => {
    mocks.prisma.teamMember.findFirst.mockResolvedValue({ teamRole: role });
    expect((await call(endpoint)).statusCode).toBe(403);
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it('honors configured team grants', async () => {
    config.org_features!.role_grants = { team: { registrar: ['members.manage'] } };
    mocks.prisma.teamMember.findFirst.mockResolvedValue({ teamRole: 'registrar' });
    expect((await call(endpoint)).statusCode).toBe(200);
  });

  it('refuses a deactivated org member despite an old owner token', async () => {
    mocks.prisma.orgMember.findFirst.mockResolvedValue(null);
    expect((await call(endpoint, { 'x-uoa-access-token': 'old-token' })).statusCode).toBe(403);
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it.each([
    { 'x-uoa-access-token': '' },
    { 'x-uoa-subject-assertion': '' },
    { 'x-uoa-access-token': 'user-token', 'x-uoa-subject-assertion': 'subject' },
  ])('refuses malformed or ambiguous credentials', async (headers) => {
    expect((await call(endpoint, headers)).statusCode).toBe(401);
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it('does not ignore an invalid subject assertion', async () => {
    mocks.assertion.mockRejectedValueOnce(new AppError('UNAUTHORIZED', 401));
    expect((await call(endpoint)).statusCode).toBe(401);
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it('requires backend mode to be explicitly enabled', async () => {
    config.org_features!.backend_org_management = false;
    expect((await call(endpoint, {})).statusCode).toBe(401);
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it('refuses a backend targeting an organisation created by another domain', async () => {
    mocks.prisma.organisation.findFirst.mockResolvedValueOnce(null);
    expect((await call(endpoint, {})).statusCode).toBe(404);
    expect(mocks.prisma.organisation.findFirst).toHaveBeenCalledWith({
      where: { id: 'org-1', domain: config.domain }, select: { id: true },
    });
    expect(endpoint.service).not.toHaveBeenCalled();
  });

  it('accepts deliberate backend mode and preserves its tenant context', async () => {
    expect((await call(endpoint, {})).statusCode).toBe(200);
    expect(mocks.tenant).toHaveBeenCalledWith(expect.objectContaining({
      orgBackendCaller: { domain: config.domain },
    }), { orgId: 'org-1', userId: null });
  });
});
