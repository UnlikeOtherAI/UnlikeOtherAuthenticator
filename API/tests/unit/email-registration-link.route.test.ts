import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { AppError } from '../../src/utils/errors.js';
import { testUiTheme } from '../helpers/test-config.js';

const validateRegistrationEmailLandingTokenMock = vi.fn();
const renderAuthEntrypointHtmlMock = vi.fn();
const finalizeAuthenticatedUserMock = vi.fn();
const verifyEmailTokenMock = vi.fn();
// Gap-fix B Task 1 (design §4.3): magic-link → chooser wiring.
const buildWorkspaceChoicesMock = vi.fn();
const signLoginSessionMock = vi.fn();

let currentConfig: ClientConfig | null = null;
const PKCE_QUERY =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';

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

vi.mock('../../src/services/auth-registration-email-link.service.js', () => ({
  validateRegistrationEmailLandingToken: (...args: unknown[]) =>
    validateRegistrationEmailLandingTokenMock(...args),
}));

vi.mock('../../src/services/access-request-flow.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/access-request-flow.service.js')>(
    '../../src/services/access-request-flow.service.js',
  );

  return {
    ...actual,
    finalizeAuthenticatedUser: (...args: unknown[]) => finalizeAuthenticatedUserMock(...args),
  };
});

vi.mock('../../src/services/auth-verify-email.service.js', () => ({
  verifyEmailToken: (...args: unknown[]) => verifyEmailTokenMock(...args),
}));

vi.mock('../../src/services/login-session.service.js', () => ({
  signLoginSession: (...args: unknown[]) => signLoginSessionMock(...args),
}));

vi.mock('../../src/services/first-login.service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/services/first-login.service.js')>(
      '../../src/services/first-login.service.js',
    );
  return { ...actual, buildWorkspaceChoices: (...args: unknown[]) => buildWorkspaceChoicesMock(...args) };
});

vi.mock('../../src/services/auth-ui.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/auth-ui.service.js')>(
    '../../src/services/auth-ui.service.js',
  );

  return {
    ...actual,
    renderAuthEntrypointHtml: (...args: unknown[]) => renderAuthEntrypointHtmlMock(...args),
  };
});

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
    org_features: {
      enabled: false,
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
  };
}

describe('GET /auth/email/link', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    validateRegistrationEmailLandingTokenMock.mockReset();
    renderAuthEntrypointHtmlMock.mockReset();
    finalizeAuthenticatedUserMock.mockReset();
    verifyEmailTokenMock.mockReset();
    buildWorkspaceChoicesMock.mockReset();
    signLoginSessionMock.mockReset();
    renderAuthEntrypointHtmlMock.mockResolvedValue('<html>login</html>');
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the login screen instead of an auth error when a one-time email link is already used', async () => {
    validateRegistrationEmailLandingTokenMock.mockRejectedValue(
      new AppError('BAD_REQUEST', 400, 'TOKEN_ALREADY_USED'),
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url:
        '/auth/email/link?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
        '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
        '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
        '&code_challenge_method=S256' +
        '&token=already-used-token',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('<html>login</html>');
    expect(renderAuthEntrypointHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl:
          '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
          '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
          '&code_challenge_method=S256',
      }),
    );

    await app.close();
  });

  it('renders the login screen instead of an auth error when the email link has no PKCE challenge', async () => {
    validateRegistrationEmailLandingTokenMock.mockResolvedValue('LOGIN_LINK');

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url:
        '/auth/email/link?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
        '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
        '&token=missing-pkce-token',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('<html>login</html>');
    expect(renderAuthEntrypointHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl:
          '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback',
      }),
    );
    expect(verifyEmailTokenMock).not.toHaveBeenCalled();
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('renders the login screen instead of an auth error when the email link has an invalid PKCE challenge', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url:
        '/auth/email/link?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
        '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
        '&code_challenge=short' +
        '&code_challenge_method=S256' +
        '&token=invalid-pkce-token',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('<html>login</html>');
    expect(renderAuthEntrypointHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl:
          '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback',
      }),
    );
    expect(validateRegistrationEmailLandingTokenMock).not.toHaveBeenCalled();
    expect(verifyEmailTokenMock).not.toHaveBeenCalled();
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('GET /auth/email/link — workspace chooser wiring (gap-fix B Task 1, design §4.3)', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    validateRegistrationEmailLandingTokenMock.mockReset().mockResolvedValue('LOGIN_LINK');
    renderAuthEntrypointHtmlMock.mockReset().mockResolvedValue('<html>login</html>');
    finalizeAuthenticatedUserMock.mockReset();
    verifyEmailTokenMock.mockReset().mockResolvedValue({ userId: 'user-1', teamInviteId: null });
    buildWorkspaceChoicesMock.mockReset();
    signLoginSessionMock.mockReset();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function getLink() {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      return await app.inject({
        method: 'GET',
        url:
          '/auth/email/link?' +
          'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
          PKCE_QUERY +
          '&token=valid-login-link-token',
        headers: { accept: 'text/html' },
      });
    } finally {
      await app.close();
    }
  }

  it('workspace_selection "off" (default): unchanged — finalizes and redirects with the code', async () => {
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'abc123',
      redirectTo: 'https://client.example.com/oauth/callback?code=abc123',
    });

    const res = await getLink();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.example.com/oauth/callback?code=abc123');
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });

  it('workspace_selection "auto" + 2+ ACTIVE teams: redirects to /auth with login_token + flow=workspace_chooser, PKCE preserved, correct audience', async () => {
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

    const res = await getLink();

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string, 'http://localhost');
    expect(location.pathname).toBe('/auth');
    expect(location.searchParams.get('login_token')).toBe('login_token_abc');
    expect(location.searchParams.get('flow')).toBe('workspace_chooser');
    expect(location.searchParams.get('config_url')).toBe('https://client.example.com/auth-config');
    expect(location.searchParams.get('redirect_url')).toBe(
      'https://client.example.com/oauth/callback',
    );
    expect(location.searchParams.get('code_challenge')).toBe(
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
    // Regression guard (per CLAUDE.md / spec): must sign with LOGIN_SESSION_AUDIENCE, not the
    // auth-service identifier — a past bug signed the bridge with the wrong audience and broke
    // verification downstream at /auth/session-choices and /auth/select-team.
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
      code: 'abc123',
      redirectTo: 'https://client.example.com/oauth/callback?code=abc123',
    });

    const res = await getLink();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.example.com/oauth/callback?code=abc123');
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });

  it('invite-bound link (teamInviteId set): the chooser is never interposed, even with workspace_selection "auto"', async () => {
    currentConfig = baseConfig({
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    verifyEmailTokenMock.mockResolvedValue({ userId: 'user-1', teamInviteId: 'invite-1' });
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'abc123',
      redirectTo: 'https://client.example.com/oauth/callback?code=abc123',
    });

    const res = await getLink();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://client.example.com/oauth/callback?code=abc123');
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
    expect(signLoginSessionMock).not.toHaveBeenCalled();
  });
});
