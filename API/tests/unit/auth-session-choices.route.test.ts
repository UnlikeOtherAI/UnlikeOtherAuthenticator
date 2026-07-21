import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { signLoginSession } from '../../src/services/login-session.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const SHARED_SECRET = 'test-shared-secret-with-enough-length';
const LOGIN_SESSION_AUDIENCE = 'uoa:login-session';

let currentConfig: ClientConfig | null = null;

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

const prismaMock = vi.hoisted(() => ({
  billingAppKey: { findMany: vi.fn() },
  clientDomain: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  teamMember: { findMany: vi.fn() },
  teamInvite: { findMany: vi.fn() },
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
    '2fa_enabled': false,
    debug_enabled: false,
    login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    org_features: {
      enabled: true,
      groups_enabled: false,
      user_needs_team: false,
      allow_user_create_org: true,
      max_teams_per_org: 100,
      max_groups_per_org: 20,
      max_members_per_org: 1000,
      max_members_per_team: 200,
      max_members_per_group: 500,
      max_team_memberships_per_user: 50,
      org_roles: ['owner', 'admin', 'member'],
    },
    ...overrides,
  } as ClientConfig;
}

async function postSessionChoices(body: Record<string, unknown>) {
  const { createApp } = await import('../../src/app.js');
  const app = await createApp();
  await app.ready();
  try {
    return await app.inject({
      method: 'POST',
      url: '/auth/session-choices?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      payload: body,
    });
  } finally {
    await app.close();
  }
}

async function mintLoginToken(userId: string, domain = 'client.example.com'): Promise<string> {
  return signLoginSession({
    userId,
    config: baseConfig({ domain }),
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

/**
 * Phase 3b Task 7 follow-up (design §4.3, §11.2): POST /auth/session-choices is the primitive the
 * SPA calls to hydrate the workspace chooser for a login_token seeded via a redirect (the social
 * callback's workspace_chooser branch). It never accepts anything but an already-verified
 * login_token, so it never leaks membership/invite data to an unverified caller.
 */
describe('POST /auth/session-choices', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    process.env.SHARED_SECRET = SHARED_SECRET;
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.DATABASE_URL = 'postgres://uoa-session-choices-tests.invalid/db';

    for (const model of Object.values(prismaMock)) {
      for (const fn of Object.values(model)) {
        (fn as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    prismaMock.clientDomain.findUnique.mockResolvedValue({ status: 'inactive' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  });

  it('rejects an invalid login_token with a generic error (no enumeration)', async () => {
    const res = await postSessionChoices({ login_token: 'not-a-real-token' });
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

    const res = await postSessionChoices({ login_token: expired });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
  });

  it('rejects a login_token minted for a different domain', async () => {
    const loginToken = await mintLoginToken('user-1', 'other.example.com');

    const res = await postSessionChoices({ login_token: loginToken });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Request failed' });
  });

  it('returns the workspace choices for a valid login_token', async () => {
    const loginToken = await mintLoginToken('user-1');
    prismaMock.user.findUnique.mockResolvedValue({ email: 'jo@example.com' });
    prismaMock.teamMember.findMany.mockResolvedValue([
      {
        teamId: 'team-1',
        teamRole: 'member',
        team: { name: 'Backend Team', orgId: 'org-1' },
      },
      {
        teamId: 'team-2',
        teamRole: 'owner',
        team: { name: 'Design Team', orgId: 'org-1' },
      },
    ]);
    prismaMock.teamInvite.findMany.mockResolvedValue([]);

    const res = await postSessionChoices({ login_token: loginToken });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Backend Team', role: 'member' },
        { teamId: 'team-2', orgId: 'org-1', name: 'Design Team', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: true,
    });
    // No login_token echoed back — the caller already holds one; only the choices are new.
    expect(res.json().login_token).toBeUndefined();
  });
});
