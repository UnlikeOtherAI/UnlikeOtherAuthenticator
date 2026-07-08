import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const requestRegistrationInstructionsMock = vi.fn();

let currentConfig: ClientConfig | null = null;

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

vi.mock('../../src/services/auth-register.service.js', () => ({
  requestRegistrationInstructions: (...args: unknown[]) =>
    requestRegistrationInstructionsMock(...args),
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

describe('POST /auth/register', () => {
  beforeEach(() => {
    currentConfig = baseConfig({ existing_user_registration_behavior: 'inline_sign_in' });
    requestRegistrationInstructionsMock.mockReset();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns EMAIL_ALREADY_REGISTERED when signed config opts into inline existing-user handling', async () => {
    requestRegistrationInstructionsMock.mockResolvedValue({ status: 'existing_user' });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url:
        '/auth/register?' +
        'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
        '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
        '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
        '&code_challenge_method=S256',
      payload: { email: 'existing@example.com' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Request failed',
      code: 'EMAIL_ALREADY_REGISTERED',
    });
    expect(requestRegistrationInstructionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'existing@example.com',
        config: currentConfig,
        configUrl: 'https://client.example.com/auth-config',
        redirectUrl: 'https://client.example.com/oauth/callback',
      }),
      expect.any(Object),
    );

    await app.close();
  });
});
