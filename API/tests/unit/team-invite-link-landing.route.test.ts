import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;

const assertTeamInviteLinkValidForLandingMock = vi.fn();
const renderAuthEntrypointHtmlMock = vi.fn();

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

vi.mock('../../src/services/team-invite-link.service.js', () => ({
  assertTeamInviteLinkValidForLanding: (...args: unknown[]) =>
    assertTeamInviteLinkValidForLandingMock(...args),
}));

vi.mock('../../src/services/auth-ui.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/auth-ui.service.js')>(
    '../../src/services/auth-ui.service.js',
  );

  return {
    ...actual,
    renderAuthEntrypointHtml: (...args: unknown[]) => renderAuthEntrypointHtmlMock(...args),
  };
});

function baseConfig(): ClientConfig {
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
  } as ClientConfig;
}

describe('GET /auth/team-invite-link/:token', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    assertTeamInviteLinkValidForLandingMock.mockReset();
    renderAuthEntrypointHtmlMock.mockReset();
    renderAuthEntrypointHtmlMock.mockResolvedValue('<html>auth-entry</html>');
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the generic invalid-link page for a bad token (no oracle)', async () => {
    assertTeamInviteLinkValidForLandingMock.mockRejectedValue(new Error('BAD_REQUEST'));

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url:
        '/auth/team-invite-link/bad-token?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Invite link unavailable');
    expect(renderAuthEntrypointHtmlMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('bootstraps the Auth entrypoint carrying invite_link_token for a valid token', async () => {
    assertTeamInviteLinkValidForLandingMock.mockResolvedValue(undefined);

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url:
        '/auth/team-invite-link/good-token?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
        '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback',
      headers: { accept: 'text/html' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('<html>auth-entry</html>');
    expect(assertTeamInviteLinkValidForLandingMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'good-token', domain: 'client.example.com' }),
      expect.anything(),
    );
    expect(renderAuthEntrypointHtmlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUrl:
          '/auth?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
          '&invite_link_token=good-token' +
          '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback',
      }),
    );

    await app.close();
  });
});
