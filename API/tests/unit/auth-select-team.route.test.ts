import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';

let currentConfig: ClientConfig | null = null;

const recordLoginLogMock = vi.fn(async () => undefined);
const assertEmailDomainAllowedForLoginMock = vi.fn(async () => undefined);
const assertNotBannedAtLoginMock = vi.fn(async () => undefined);

vi.mock('@unlikeotherai/qr-art', () => ({
  renderSVG: () => '<svg />',
}));

vi.mock('../../src/middleware/config-verifier.js', () => ({
  configVerifier: async (request: {
    query?: { config_url?: string };
    configUrl?: string;
    config?: ClientConfig;
  }): Promise<void> => {
    request.configUrl = request.query?.config_url;
    request.config = currentConfig ?? undefined;
  },
}));

vi.mock('../../src/services/login-log.service.js', () => ({
  recordLoginLog: (...args: unknown[]) => recordLoginLogMock(...args),
}));

vi.mock('../../src/services/login-domain-policy.service.js', () => ({
  assertEmailDomainAllowedForLogin: (...args: unknown[]) =>
    assertEmailDomainAllowedForLoginMock(...args),
  isEmailAdminAllowedForRegistration: vi.fn(async () => false),
}));

vi.mock('../../src/services/ban-policy.service.js', () => ({
  assertNotBannedAtLogin: (...args: unknown[]) => assertNotBannedAtLoginMock(...args),
  isPrincipalBannedForRegistration: vi.fn(async () => false),
}));

const prismaMock = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  domainSignatureSettings: { findUnique: vi.fn() },
  team: { findFirst: vi.fn() },
  teamMember: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  teamInvite: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  teamInviteLink: { findUnique: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  orgMember: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn() },
  loginSessionUse: { create: vi.fn() },
  authorizationCode: { create: vi.fn() },
  billingAppKey: { findMany: vi.fn() },
  clientDomain: { findUnique: vi.fn() },
  organisation: { findMany: vi.fn() },
}));

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: vi.fn(() => prismaMock),
  getAdminPrisma: vi.fn(() => prismaMock),
  connectPrisma: vi.fn(async () => {}),
  disconnectPrisma: vi.fn(async () => {}),
}));

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'password_required',
    '2fa_enabled': false,
    debug_enabled: false,
    login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    access_requests: { enabled: false, notify_org_roles: ['owner', 'admin'] },
    org_features: {
      enabled: true,
      groups_enabled: false,
      user_needs_team: false,
      auto_create_personal_org_on_first_login: false,
      allow_user_create_org: false,
      pending_invites_block_auto_create: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
      max_flags_per_app: 100,
      scim_override_retention: 'retain',
      global_missing_flag_default: 'disabled',
    },
    session: {
      remember_me_enabled: true,
      remember_me_default: true,
      short_refresh_token_ttl_hours: 1,
      long_refresh_token_ttl_days: 30,
    },
    ...overrides,
  } as ClientConfig;
}

const QUERY_SUFFIX =
  'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
  '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
  '&code_challenge_method=S256';

async function postSelectTeam(body: Record<string, unknown>) {
  const { createApp } = await import('../../src/app.js');
  const app = await createApp();
  await app.ready();
  try {
    return await app.inject({
      method: 'POST',
      url: `/auth/select-team?${QUERY_SUFFIX}`,
      payload: body,
    });
  } finally {
    await app.close();
  }
}

async function mintLoginToken(userId: string, domain = 'client.example.com'): Promise<string> {
  return signLoginSession({
    userId,
    config:
      currentConfig && domain === currentConfig.domain ? currentConfig : baseConfig({ domain }),
    configUrl: 'https://client.example.com/auth-config',
    redirectUrl: 'https://client.example.com/oauth/callback',
    codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    codeChallengeMethod: 'S256',
    rememberMe: true,
    requestAccess: false,
    sharedSecret: SHARED_SECRET,
    audience: LOGIN_SESSION_AUDIENCE,
  });
}

describe('POST /auth/select-team', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    process.env.SHARED_SECRET = SHARED_SECRET;
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://uoa-select-team-tests.invalid/db';

    for (const model of Object.values(prismaMock)) {
      if (typeof model !== 'object' || model === null) continue;
      for (const fn of Object.values(model)) {
        const maybeMock = fn as { mockReset?: unknown };
        if (typeof maybeMock.mockReset === 'function') {
          (fn as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
    recordLoginLogMock.mockReset().mockResolvedValue(undefined);
    assertEmailDomainAllowedForLoginMock.mockReset().mockResolvedValue(undefined);
    assertNotBannedAtLoginMock.mockReset().mockResolvedValue(undefined);
    prismaMock.authorizationCode.create.mockResolvedValue({ id: 'code-row-1' });
    prismaMock.loginSessionUse.create.mockResolvedValue({ id: 'session-use-1' });
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.domainSignatureSettings.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('rejects an invalid login_token with a generic error', async () => {
    const res = await postSelectTeam({ login_token: 'not-a-real-token', teamId: 'team-1' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
  });

  it('rejects an expired login_token with a generic error', async () => {
    const expired = await signLoginSession({
      userId: 'user-1',
      config: currentConfig!,
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      rememberMe: true,
      requestAccess: false,
      sharedSecret: SHARED_SECRET,
      audience: LOGIN_SESSION_AUDIENCE,
      now: new Date('2020-01-01T00:00:00.000Z'),
      ttlMs: 1000,
    });

    const res = await postSelectTeam({ login_token: expired, teamId: 'team-1' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
  });

  it('rejects a teamId the user is not an ACTIVE member of', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1' });
    prismaMock.teamMember.findFirst.mockResolvedValue(null); // no ACTIVE membership

    const res = await postSelectTeam({ login_token: loginToken, teamId: 'team-1' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('rejects a cross-domain team for an unknown product domain (IDOR)', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.team.findFirst.mockResolvedValue({
      id: 'team-owned-by-other-domain',
      orgId: 'org-other-domain',
    });
    prismaMock.orgMember.findFirst.mockResolvedValue(null);
    prismaMock.teamMember.findFirst.mockResolvedValue(null);
    prismaMock.clientDomain.findUnique.mockResolvedValue({ status: 'active' });
    prismaMock.billingAppKey.findMany.mockResolvedValue([]);

    const res = await postSelectTeam({
      login_token: loginToken,
      teamId: 'team-owned-by-other-domain',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith({
      where: { id: 'team-owned-by-other-domain' },
      select: { id: true, orgId: true },
    });
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('accepts a cross-domain ACTIVE team for one centrally bound product', async () => {
    currentConfig = baseConfig({ domain: 'api.deepsignal.live' });
    const loginToken = await mintLoginToken('user-1', 'api.deepsignal.live');
    prismaMock.team.findFirst.mockResolvedValue({ id: 'team-nessie', orgId: 'org-nessie' });
    prismaMock.orgMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'org-member-nessie' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'org-member-nessie' });
    prismaMock.teamMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'team-member-nessie' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'team-member-nessie' });
    prismaMock.clientDomain.findUnique.mockResolvedValue({ status: 'active' });
    prismaMock.billingAppKey.findMany.mockResolvedValue([
      {
        serviceId: 'service-deepsignal',
        service: { identifier: 'deepsignal' },
      },
    ]);
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });

    const res = await postSelectTeam({ login_token: loginToken, teamId: 'team-nessie' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-nessie', teamId: 'team-nessie' }),
      }),
    );
    expect(prismaMock.orgMember.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: 'org-nessie',
        userId: 'user-1',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  });

  it('accepts a valid ACTIVE team selection and issues a scoped authorization code', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1' });
    prismaMock.teamMember.findFirst.mockResolvedValue({ id: 'member-1' });
    prismaMock.orgMember.findFirst.mockResolvedValue({ id: 'org-member-1' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });

    const res = await postSelectTeam({ login_token: loginToken, teamId: 'team-1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(body.redirect_to).toContain('code=');
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      }),
    );
  });

  it('finalizes with no workspace scope when neither teamId nor inviteId is given', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });

    const res = await postSelectTeam({ login_token: loginToken });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: null, teamId: null }),
      }),
    );
  });

  it('enforces the selected org 2FA policy — returns a twofa challenge instead of finalizing', async () => {
    currentConfig = baseConfig({ '2fa_enabled': true });
    const loginToken = await mintLoginToken('user-1');
    prismaMock.team.findFirst.mockResolvedValue({ id: 'team-1', orgId: 'org-1' });
    prismaMock.teamMember.findFirst.mockResolvedValue({ id: 'member-1' });
    prismaMock.orgMember.findFirst.mockResolvedValue({ id: 'org-member-1' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: true });
    prismaMock.clientDomain.findUnique.mockResolvedValue({ twoFaPolicy: 'REQUIRED' });
    prismaMock.organisation.findMany.mockResolvedValue([]);

    const res = await postSelectTeam({ login_token: loginToken, teamId: 'team-1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, twofa_required: true });
    expect(typeof body.twofa_token).toBe('string');
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('accepts a pending invite and finalizes scoped to the invite team/org', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      orgId: 'org-9',
      teamId: 'team-9',
      email: 'jane@example.com',
      inviteName: null,
      teamRole: 'member',
      acceptedUserId: null,
      acceptedAt: null,
      revokedAt: null,
      org: { id: 'org-9', domain: 'client.example.com' },
    });
    prismaMock.user.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'user-1') {
        return { id: 'user-1', email: 'jane@example.com', name: null, twoFaEnabled: false };
      }
      return null;
    });
    prismaMock.orgMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'org-member-1', orgId: 'org-9' });
    prismaMock.orgMember.count.mockResolvedValue(1);
    prismaMock.orgMember.create.mockResolvedValue({ id: 'org-member-1' });
    prismaMock.teamMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'team-member-1', status: 'ACTIVE' });
    prismaMock.teamMember.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    prismaMock.teamMember.create.mockResolvedValue({ id: 'team-member-1' });
    prismaMock.teamInvite.update.mockResolvedValue({ id: 'invite-1' });
    prismaMock.user.update.mockResolvedValue({ id: 'user-1' });

    const res = await postSelectTeam({ login_token: loginToken, inviteId: 'invite-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-9', teamId: 'team-9' }),
      }),
    );
  });

  it('declines a pending invite and returns a refreshed chooser payload', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.teamInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      email: 'jane@example.com',
      acceptedAt: null,
      declinedAt: null,
      revokedAt: null,
      org: { domain: 'client.example.com' },
    });
    prismaMock.user.findUnique.mockResolvedValue({ email: 'jane@example.com' });
    prismaMock.teamInvite.update.mockResolvedValue({ id: 'invite-1' });
    prismaMock.teamMember.findMany.mockResolvedValue([]);
    prismaMock.teamInvite.findMany.mockResolvedValue([]);

    const res = await postSelectTeam({
      login_token: loginToken,
      inviteId: 'invite-1',
      action: 'decline',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.login_token).toBe(loginToken);
    expect(body).toMatchObject({ teams: [], pending_invites: [], can_create_org: false });
    expect(prismaMock.teamInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invite-1' },
        data: { declinedAt: expect.any(Date) },
      }),
    );
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('redeems a valid inviteLinkToken and finalizes scoped to its team (Phase 5)', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.teamInviteLink.findUnique.mockResolvedValue({
      id: 'link-1',
      orgId: 'org-7',
      teamId: 'team-7',
      roleToAssign: 'member',
      maxUses: 400,
      useCount: 1,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.team.findFirst.mockResolvedValue({
      id: 'team-7',
      orgId: 'org-7',
      joinPolicy: 'INVITE_ONLY',
    });
    prismaMock.teamInviteLink.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.orgMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'om-1', orgId: 'org-7', status: 'ACTIVE' });
    prismaMock.orgMember.create.mockResolvedValue({ id: 'om-1' });
    prismaMock.teamMember.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'tm-1', status: 'ACTIVE' });
    prismaMock.teamMember.create.mockResolvedValue({ id: 'tm-1' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });

    const res = await postSelectTeam({
      login_token: loginToken,
      inviteLinkToken: 'plaintext-link-token',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prismaMock.teamInviteLink.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'link-1' }) }),
    );
    expect(prismaMock.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ teamId: 'team-7', userId: 'user-1', teamRole: 'member' }),
      }),
    );
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: 'org-7', teamId: 'team-7' }),
      }),
    );
  });

  it('enforces the selected org 2FA policy after redeeming an invite link (Phase 5)', async () => {
    currentConfig = baseConfig({ '2fa_enabled': true });
    const loginToken = await mintLoginToken('user-1');
    prismaMock.teamInviteLink.findUnique.mockResolvedValue({
      id: 'link-2',
      orgId: 'org-8',
      teamId: 'team-8',
      roleToAssign: 'member',
      maxUses: 400,
      useCount: 0,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prismaMock.team.findFirst.mockResolvedValue({
      id: 'team-8',
      orgId: 'org-8',
      joinPolicy: 'INVITE_ONLY',
    });
    prismaMock.teamInviteLink.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.orgMember.findFirst.mockResolvedValue({
      id: 'om-2',
      orgId: 'org-8',
      status: 'ACTIVE',
    });
    prismaMock.teamMember.findFirst.mockResolvedValue({ id: 'tm-2', status: 'ACTIVE' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: true });
    prismaMock.clientDomain.findUnique.mockResolvedValue({ twoFaPolicy: 'REQUIRED' });
    prismaMock.organisation.findMany.mockResolvedValue([]);

    const res = await postSelectTeam({
      login_token: loginToken,
      inviteLinkToken: 'plaintext-link-token',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, twofa_required: true });
    expect(typeof body.twofa_token).toBe('string');
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid/unknown inviteLinkToken with a generic error (Phase 5)', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.teamInviteLink.findUnique.mockResolvedValue(null);

    const res = await postSelectTeam({ login_token: loginToken, inviteLinkToken: 'bad-token' });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('rejects a request combining inviteLinkToken with teamId (mutually exclusive)', async () => {
    const loginToken = await mintLoginToken('user-1');

    const res = await postSelectTeam({
      login_token: loginToken,
      inviteLinkToken: 'some-token',
      teamId: 'team-1',
    });

    expect(res.statusCode).toBe(400);
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });
});
