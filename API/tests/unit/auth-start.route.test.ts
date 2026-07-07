import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const requestRegistrationInstructionsMock = vi.fn();
const issueLoginCodeMock = vi.fn();

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

vi.mock('../../src/services/login-code.service.js', () => ({
  issueLoginCode: (...args: unknown[]) => issueLoginCodeMock(...args),
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
    login_flow: { email_code_enabled: false, workspace_selection: 'off' },
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
  } as ClientConfig;
}

const QUERY_SUFFIX =
  'config_url=https%3A%2F%2Fclient.example.com%2Fauth-config' +
  '&redirect_url=https%3A%2F%2Fclient.example.com%2Foauth%2Fcallback' +
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
  '&code_challenge_method=S256';

describe('POST /auth/start', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    requestRegistrationInstructionsMock.mockReset().mockResolvedValue({ status: 'sent' });
    issueLoginCodeMock.mockReset().mockResolvedValue(undefined);
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postStart(email: unknown) {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      return await app.inject({
        method: 'POST',
        url: `/auth/start?${QUERY_SUFFIX}`,
        payload: { email },
      });
    } finally {
      await app.close();
    }
  }

  it('returns the identical generic body for an existing email', async () => {
    const res = await postStart('existing@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
  });

  it('returns the identical generic body for an unknown/new email', async () => {
    requestRegistrationInstructionsMock.mockResolvedValue({ status: 'sent' });
    const res = await postStart('brand-new@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
  });

  it('returns the identical generic body for a malformed email (no enumeration)', async () => {
    const res = await postStart('not-an-email');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
    // Malformed input never reaches the instruction/code services at all.
    expect(requestRegistrationInstructionsMock).not.toHaveBeenCalled();
    expect(issueLoginCodeMock).not.toHaveBeenCalled();
  });

  it('does NOT issue a login code when login_flow.email_code_enabled is false (default)', async () => {
    currentConfig = baseConfig({ login_flow: { email_code_enabled: false, workspace_selection: 'off' } });
    const res = await postStart('jane@example.com');
    expect(res.statusCode).toBe(200);
    expect(issueLoginCodeMock).not.toHaveBeenCalled();
  });

  it('issues a login code (best-effort) when login_flow.email_code_enabled is true', async () => {
    currentConfig = baseConfig({ login_flow: { email_code_enabled: true, workspace_selection: 'off' } });
    const res = await postStart('jane@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
    expect(issueLoginCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jane@example.com' }),
      expect.any(Object),
    );
  });

  it('still returns the generic success response when issueLoginCode throws', async () => {
    currentConfig = baseConfig({ login_flow: { email_code_enabled: true, workspace_selection: 'off' } });
    issueLoginCodeMock.mockRejectedValue(new Error('boom'));

    const res = await postStart('jane@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'We sent instructions to your email' });
  });

  it('returns EMAIL_ALREADY_REGISTERED when signed config opts into inline existing-user handling', async () => {
    currentConfig = baseConfig({ existing_user_registration_behavior: 'inline_sign_in' });
    requestRegistrationInstructionsMock.mockResolvedValue({ status: 'existing_user' });

    const res = await postStart('existing@example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Request failed', code: 'EMAIL_ALREADY_REGISTERED' });
    // Existing-user short-circuit must not also attempt to issue a login code.
    expect(issueLoginCodeMock).not.toHaveBeenCalled();
  });
});
