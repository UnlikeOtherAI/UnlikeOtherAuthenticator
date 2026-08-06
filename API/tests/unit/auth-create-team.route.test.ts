import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';
const QUERY_SUFFIX =
  'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
  '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
  '&code_challenge_method=S256';

let currentConfig: ClientConfig | null = null;

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  team: { findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const consumeLoginSessionMock = vi.hoisted(() => vi.fn());
const createTeamMock = vi.hoisted(() => vi.fn());
const addTeamMemberMock = vi.hoisted(() => vi.fn());
const finalizeWithTwoFaPolicyMock = vi.hoisted(() => vi.fn());
const lockAuthenticationEpochMock = vi.hoisted(() => vi.fn());
const lockProductWorkspacePolicyMock = vi.hoisted(() => vi.fn());
const lockWorkspaceScopeMock = vi.hoisted(() => vi.fn());
const recordLoginLogMock = vi.hoisted(() => vi.fn());

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

vi.mock('../../src/services/login-session-use.service.js', () => ({
  consumeLoginSession: (...args: unknown[]) => consumeLoginSessionMock(...args),
}));
vi.mock('../../src/services/team.service.teams.js', () => ({
  createTeam: (...args: unknown[]) => createTeamMock(...args),
}));
vi.mock('../../src/services/team.service.members.js', () => ({
  addTeamMember: (...args: unknown[]) => addTeamMemberMock(...args),
}));
vi.mock('../../src/services/workspace-finalize.service.js', () => ({
  finalizeWithTwoFaPolicy: (...args: unknown[]) => finalizeWithTwoFaPolicyMock(...args),
}));
vi.mock('../../src/services/authentication-epoch.service.js', () => ({
  lockAndAssertAuthenticationEpoch: (...args: unknown[]) => lockAuthenticationEpochMock(...args),
}));
vi.mock('../../src/services/product-workspace-policy-lock.service.js', () => ({
  lockProductWorkspacePolicyShared: (...args: unknown[]) => lockProductWorkspacePolicyMock(...args),
}));
vi.mock('../../src/services/workspace-scope.service.js', () => ({
  lockAndAssertActiveClientWorkspaceScope: (...args: unknown[]) => lockWorkspaceScopeMock(...args),
}));
vi.mock('../../src/services/login-log.service.js', () => ({
  recordLoginLog: (...args: unknown[]) => recordLoginLogMock(...args),
}));

function baseConfig(allowTeamCreation = true): ClientConfig {
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
      allow_user_create_team: allowTeamCreation,
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
  } as ClientConfig;
}

async function mintLoginToken(): Promise<string> {
  return signLoginSession({
    userId: 'user-1',
    credentialEpoch: 0,
    authMethod: 'google',
    config: currentConfig!,
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

async function postCreateTeam(body: Record<string, unknown>) {
  const { registerAuthCreateTeamRoute } =
    await import('../../src/routes/auth/auth-create-team.js');
  const app = fastify();
  app.decorateRequest('adminDb', { getter: () => prismaMock as never });
  registerErrorHandler(app);
  registerAuthCreateTeamRoute(app);
  await app.ready();
  try {
    return await app.inject({
      method: 'POST',
      url: `/auth/create-team?${QUERY_SUFFIX}`,
      payload: body,
    });
  } finally {
    await app.close();
  }
}

describe('POST /auth/create-team', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    process.env.SHARED_SECRET = SHARED_SECRET;
    process.env.DATABASE_URL = 'postgres://uoa-create-team-tests.invalid/db';

    for (const mock of [
      prismaMock.team.findFirst,
      prismaMock.$queryRaw,
      prismaMock.user.findUnique,
      consumeLoginSessionMock,
      createTeamMock,
      addTeamMemberMock,
      finalizeWithTwoFaPolicyMock,
      lockAuthenticationEpochMock,
      lockProductWorkspacePolicyMock,
      lockWorkspaceScopeMock,
      recordLoginLogMock,
    ]) {
      mock.mockReset();
    }

    prismaMock.team.findFirst.mockResolvedValue({ id: 'team-new' });
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });
    consumeLoginSessionMock.mockResolvedValue(undefined);
    createTeamMock.mockResolvedValue({ id: 'team-new', slug: 'support' });
    addTeamMemberMock.mockResolvedValue({ id: 'team-member-new' });
    finalizeWithTwoFaPolicyMock.mockResolvedValue({
      kind: 'granted',
      finalResult: {
        status: 'granted',
        code: 'authorization-code',
        redirectTo: 'https://client.example.com/oauth/callback?code=authorization-code',
      },
    });
    lockAuthenticationEpochMock.mockResolvedValue({ twoFaEnabled: false });
    lockProductWorkspacePolicyMock.mockResolvedValue(undefined);
    lockWorkspaceScopeMock.mockResolvedValue(undefined);
    recordLoginLogMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
    vi.restoreAllMocks();
  });

  it('creates the workspace in the named org, adds the creator, and finalizes the same continuation', async () => {
    const loginToken = await mintLoginToken();
    const res = await postCreateTeam({ login_token: loginToken, org_id: 'org-1', name: 'Support' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'authorization-code',
      redirect_to: 'https://client.example.com/oauth/callback?code=authorization-code',
    });
    // `createTeam` is the authorization boundary: it resolves org-1 against THIS config's domain
    // and runs requireTeamManager on the acting user.
    expect(createTeamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        domain: 'client.example.com',
        name: 'Support',
        actorUserId: 'user-1',
      }),
      { prisma: prismaMock, auditPrisma: prismaMock },
    );
    // The creator must be IN the workspace they just made, or it would not even be selectable.
    expect(addTeamMemberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        teamId: 'team-new',
        userId: 'user-1',
        teamRole: 'admin',
      }),
      { prisma: prismaMock, auditPrisma: prismaMock },
    );
    expect(lockWorkspaceScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        domain: 'client.example.com',
        orgId: 'org-1',
        teamId: 'team-new',
      }),
      expect.anything(),
    );
    expect(finalizeWithTwoFaPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 'team-new' }),
      expect.anything(),
    );
    // The bridge token is claimed before the write, so a replay cannot leave a second workspace.
    expect(consumeLoginSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      createTeamMock.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects creation when the domain has not enabled allow_user_create_team', async () => {
    currentConfig = baseConfig(false);
    const loginToken = await mintLoginToken();
    const res = await postCreateTeam({ login_token: loginToken, org_id: 'org-1', name: 'Support' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
    expect(consumeLoginSessionMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
    expect(finalizeWithTwoFaPolicyMock).not.toHaveBeenCalled();
  });

  it('rejects a create request outside the auto workspace-selection flow', async () => {
    currentConfig = {
      ...baseConfig(),
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
    } as ClientConfig;
    const loginToken = await mintLoginToken();
    const res = await postCreateTeam({ login_token: loginToken, org_id: 'org-1', name: 'Support' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
    expect(consumeLoginSessionMock).not.toHaveBeenCalled();
    expect(createTeamMock).not.toHaveBeenCalled();
  });

  it('surfaces the org role check: a non-manager gets createTeam\'s 403, and nothing is finalized', async () => {
    const { AppError } = await import('../../src/utils/errors.js');
    createTeamMock.mockRejectedValue(new AppError('FORBIDDEN', 403));
    const loginToken = await mintLoginToken();
    const res = await postCreateTeam({ login_token: loginToken, org_id: 'org-1', name: 'Support' });

    expect(res.statusCode).toBe(403);
    expect(addTeamMemberMock).not.toHaveBeenCalled();
    expect(finalizeWithTwoFaPolicyMock).not.toHaveBeenCalled();
  });

  it('requires an org_id — a workspace always lives inside an organisation', async () => {
    const loginToken = await mintLoginToken();
    const res = await postCreateTeam({ login_token: loginToken, name: 'Support' });

    expect(res.statusCode).toBe(400);
    expect(createTeamMock).not.toHaveBeenCalled();
  });
});
