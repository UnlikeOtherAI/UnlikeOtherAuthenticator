import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const validateVerifyEmailTokenMock = vi.fn();
const verifyEmailTokenMock = vi.fn();
const finalizeAuthenticatedUserMock = vi.fn();
const buildWorkspaceChoicesMock = vi.fn();
const signLoginSessionMock = vi.fn();

let currentConfig: ClientConfig | null = null;
const PKCE_QUERY =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';

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

vi.mock('../../src/services/auth-verify-email.service.js', () => ({
  validateVerifyEmailToken: (...args: unknown[]) => validateVerifyEmailTokenMock(...args),
  verifyEmailToken: (...args: unknown[]) => verifyEmailTokenMock(...args),
}));

vi.mock('../../src/services/access-request-flow.service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/services/access-request-flow.service.js')>(
      '../../src/services/access-request-flow.service.js',
    );
  return {
    ...actual,
    finalizeAuthenticatedUser: (...args: unknown[]) => finalizeAuthenticatedUserMock(...args),
  };
});

vi.mock('../../src/services/first-login.service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/services/first-login.service.js')>(
      '../../src/services/first-login.service.js',
    );
  return { ...actual, buildWorkspaceChoices: (...args: unknown[]) => buildWorkspaceChoicesMock(...args) };
});

vi.mock('../../src/services/login-session.service.js', () => ({
  signLoginSession: (...args: unknown[]) => signLoginSessionMock(...args),
}));

vi.mock('../../src/services/login-log.service.js', () => ({
  recordLoginLog: vi.fn(async () => undefined),
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
    access_requests: { enabled: false, notify_org_roles: ['owner', 'admin'] },
    ...overrides,
  } as ClientConfig;
}

describe('POST /auth/verify-email — workspace chooser wiring (gap-fix B Task 1, design §4.3)', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    validateVerifyEmailTokenMock.mockReset().mockResolvedValue('VERIFY_EMAIL_SET_PASSWORD');
    verifyEmailTokenMock.mockReset().mockResolvedValue({
      userId: 'user-1',
      type: 'VERIFY_EMAIL_SET_PASSWORD',
      teamInviteId: null,
    });
    finalizeAuthenticatedUserMock.mockReset();
    buildWorkspaceChoicesMock.mockReset();
    signLoginSessionMock.mockReset();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postVerifyEmail() {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      return await app.inject({
        method: 'POST',
        url:
          '/auth/verify-email?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
          PKCE_QUERY,
        payload: { token: 'a-verify-email-token', password: 'Abcdef1!' },
      });
    } finally {
      await app.close();
    }
  }

  it('workspace_selection "off" (default): behaves exactly like before — no login_token, direct finalize', async () => {
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const res = await postVerifyEmail();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'auth_code_1',
      redirect_to: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });

  it('workspace_selection "auto" + 2+ ACTIVE teams: returns the login_token + chooser payload instead of finalizing', async () => {
    currentConfig = baseConfig({
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', slug: 'design', role: 'member', iconUrl: null },
        {
          teamId: 'team-2',
          orgId: 'org-1',
          name: 'Engineering',
          slug: 'engineering',
          role: 'owner',
          iconUrl: null,
        },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    signLoginSessionMock.mockResolvedValue('login_token_abc');

    const res = await postVerifyEmail();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      login_token: 'login_token_abc',
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', slug: 'design', role: 'member', iconUrl: null },
        {
          teamId: 'team-2',
          orgId: 'org-1',
          name: 'Engineering',
          slug: 'engineering',
          role: 'owner',
          iconUrl: null,
        },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
    // Regression guard (per CLAUDE.md / spec): must sign with LOGIN_SESSION_AUDIENCE, not the
    // auth-service identifier, or the bridge fails verification at /auth/select-team.
    expect(signLoginSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ audience: LOGIN_SESSION_AUDIENCE }),
    );
  });

  it('workspace_selection "auto" but only 1 ACTIVE team and no invites: unchanged finalize (auto-skip)', async () => {
    currentConfig = baseConfig({
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Solo', slug: 'solo', role: 'owner', iconUrl: null },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const res = await postVerifyEmail();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'auth_code_1',
      redirect_to: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });

  it('invite-bound token (teamInviteId set): the chooser is never interposed, even with workspace_selection "auto"', async () => {
    currentConfig = baseConfig({
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    verifyEmailTokenMock.mockResolvedValue({
      userId: 'user-1',
      type: 'VERIFY_EMAIL_SET_PASSWORD',
      teamInviteId: 'invite-1',
    });
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const res = await postVerifyEmail();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'auth_code_1',
      redirect_to: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });
});
