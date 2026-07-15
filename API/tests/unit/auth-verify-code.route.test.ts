import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;

const verifyLoginCodeMock = vi.fn();
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

vi.mock('../../src/services/login-code.service.js', () => ({
  verifyLoginCode: (...args: unknown[]) => verifyLoginCodeMock(...args),
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

const prismaMock = vi.hoisted(() => {
  const mock: Record<string, unknown> = {
    user: { findUnique: vi.fn() },
    teamMember: { findMany: vi.fn() },
    teamInvite: { findMany: vi.fn() },
    authorizationCode: { create: vi.fn() },
    domainSignatureSettings: { findUnique: vi.fn() },
    clientDomain: { findUnique: vi.fn() },
    organisation: { findMany: vi.fn() },
  };
  // The "off" branch runs inside request.withTenantTx, which opens a real
  // prisma.$transaction(...) and issues a `SELECT set_config(...)` via $executeRaw before
  // invoking the handler with the tx client. Stub both so the real tenant-context plumbing
  // can run against this mock the same way it does against a real Prisma client.
  mock.$transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(mock));
  mock.$executeRaw = vi.fn(async () => undefined);
  return mock;
});

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
    login_flow: { email_code_enabled: true, workspace_selection: 'off' },
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

async function postVerifyCode(body: Record<string, unknown>) {
  const { createApp } = await import('../../src/app.js');
  const app = await createApp();
  await app.ready();
  try {
    return await app.inject({
      method: 'POST',
      url: `/auth/verify-code?${QUERY_SUFFIX}`,
      payload: body,
    });
  } finally {
    await app.close();
  }
}

describe('POST /auth/verify-code', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://uoa-verify-code-tests.invalid/db';

    for (const model of Object.values(prismaMock)) {
      if (typeof model !== 'object' || model === null) continue;
      for (const fn of Object.values(model as Record<string, unknown>)) {
        const maybeMock = fn as { mockReset?: unknown };
        if (typeof maybeMock.mockReset === 'function') {
          (fn as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
    verifyLoginCodeMock.mockReset();
    recordLoginLogMock.mockReset().mockResolvedValue(undefined);
    assertEmailDomainAllowedForLoginMock.mockReset().mockResolvedValue(undefined);
    assertNotBannedAtLoginMock.mockReset().mockResolvedValue(undefined);
    prismaMock.authorizationCode.create.mockResolvedValue({ id: 'code-row-1' });
    prismaMock.$executeRaw.mockResolvedValue(1);
    prismaMock.domainSignatureSettings.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('returns the same generic error for a wrong/expired/unknown code', async () => {
    const { AppError } = await import('../../src/utils/errors.js');
    verifyLoginCodeMock.mockRejectedValue(new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'));

    const res = await postVerifyCode({ email: 'jane@example.com', code: '000000' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
  });

  it('workspace_selection "auto": returns login_token + chooser payload without finalizing', async () => {
    currentConfig = baseConfig({ login_flow: { email_code_enabled: true, workspace_selection: 'auto' } });
    verifyLoginCodeMock.mockResolvedValue({ userId: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue({ email: 'jane@example.com' });
    prismaMock.teamMember.findMany.mockResolvedValue([
      { teamId: 'team-1', teamRole: 'member', team: { name: 'Design', orgId: 'org-1' } },
    ]);
    prismaMock.teamInvite.findMany.mockResolvedValue([]);

    const res = await postVerifyCode({ email: 'jane@example.com', code: '123456' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.login_token).toBe('string');
    expect(body.teams).toEqual([{ teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' }]);
    expect(body.pending_invites).toEqual([]);
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });

  it('workspace_selection "off" (default): finalizes immediately like /auth/login', async () => {
    verifyLoginCodeMock.mockResolvedValue({ userId: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: false });

    const res = await postVerifyCode({ email: 'jane@example.com', code: '123456' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.code).toBe('string');
    expect(prismaMock.authorizationCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: null, teamId: null }),
      }),
    );
  });

  it('workspace_selection "off" still enforces 2FA — returns a twofa challenge, not a code', async () => {
    currentConfig = baseConfig({ '2fa_enabled': true, login_flow: { email_code_enabled: true, workspace_selection: 'off' } });
    verifyLoginCodeMock.mockResolvedValue({ userId: 'user-1' });
    prismaMock.user.findUnique.mockResolvedValue({ twoFaEnabled: true });
    prismaMock.clientDomain.findUnique.mockResolvedValue({ twoFaPolicy: 'REQUIRED' });
    prismaMock.organisation.findMany.mockResolvedValue([]);

    const res = await postVerifyCode({ email: 'jane@example.com', code: '123456' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, twofa_required: true });
    expect(typeof body.twofa_token).toBe('string');
    expect(prismaMock.authorizationCode.create).not.toHaveBeenCalled();
  });
});
