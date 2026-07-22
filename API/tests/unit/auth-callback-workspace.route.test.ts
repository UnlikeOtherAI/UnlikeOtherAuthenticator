import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JWTPayload } from 'jose';

import type { ClientConfig } from '../../src/services/config.service.js';
import { verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const readConfigJwtFromTrustedSourceMock = vi.fn();
const verifyConfigJwtSignatureMock = vi.fn();
const validateConfigFieldsMock = vi.fn();
const assertConfigDomainMatchesConfigUrlMock = vi.fn();
const assertSocialProviderAllowedMock = vi.fn();
const getGoogleProfileFromCodeMock = vi.fn();
const verifySocialStateMock = vi.fn();
const loginWithSocialProfileMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const signLoginSessionMock = vi.fn();
const buildWorkspaceChoicesMock = vi.fn();
const finalizeAuthenticatedUserMock = vi.fn();
const startTwoFactorSetupMock = vi.fn();

vi.mock('../../src/services/config-jwt-source.service.js', () => ({
  readConfigJwtFromTrustedSource: (...args: unknown[]) =>
    readConfigJwtFromTrustedSourceMock(...args),
}));

vi.mock('../../src/services/config.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/config.service.js')>(
    '../../src/services/config.service.js',
  );
  return {
    ...actual,
    verifyConfigJwtSignature: (...args: unknown[]) => verifyConfigJwtSignatureMock(...args),
    validateConfigFields: (...args: unknown[]) => validateConfigFieldsMock(...args),
    assertConfigDomainMatchesConfigUrl: (...args: unknown[]) =>
      assertConfigDomainMatchesConfigUrlMock(...args),
  };
});

vi.mock('../../src/services/social/index.js', () => ({
  assertSocialProviderAllowed: (...args: unknown[]) => assertSocialProviderAllowedMock(...args),
}));

vi.mock('../../src/services/social/google.service.js', () => ({
  getGoogleProfileFromCode: (...args: unknown[]) => getGoogleProfileFromCodeMock(...args),
}));

vi.mock('../../src/services/social/social-state.service.js', () => ({
  verifySocialState: (...args: unknown[]) => verifySocialStateMock(...args),
}));

vi.mock('../../src/services/social/social-login.service.js', () => ({
  loginWithSocialProfile: (...args: unknown[]) => loginWithSocialProfileMock(...args),
}));

vi.mock('../../src/services/twofactor-policy.service.js', () => ({
  resolveTwoFaPolicy: (...args: unknown[]) => resolveTwoFaPolicyMock(...args),
}));

vi.mock('../../src/services/login-session.service.js', () => ({
  signLoginSession: (...args: unknown[]) => signLoginSessionMock(...args),
}));

vi.mock('../../src/services/first-login.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/first-login.service.js')>(
    '../../src/services/first-login.service.js',
  );
  return {
    ...actual,
    buildWorkspaceChoices: (...args: unknown[]) => buildWorkspaceChoicesMock(...args),
  };
});

vi.mock('../../src/services/access-request-flow.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/access-request-flow.service.js')
  >('../../src/services/access-request-flow.service.js');
  return {
    ...actual,
    finalizeAuthenticatedUser: (...args: unknown[]) => finalizeAuthenticatedUserMock(...args),
  };
});

vi.mock('../../src/services/twofactor-setup.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/twofactor-setup.service.js')
  >('../../src/services/twofactor-setup.service.js');
  return {
    ...actual,
    startTwoFactorSetup: (...args: unknown[]) => startTwoFactorSetupMock(...args),
  };
});

const TEST_NONCE = 'test-social-state-nonce';
const SOCIAL_STATE_COOKIE_NAME = 'uoa_social_state';
const CONFIG_URL = 'https://client.example.com/auth-config';
const REDIRECT_URL = 'https://client.example.com/oauth/callback';

function baseConfig(overrides?: Partial<ClientConfig>): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: [REDIRECT_URL],
    enabled_auth_methods: ['google'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    '2fa_enabled': false,
    debug_enabled: false,
    login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    ...overrides,
  };
}

async function runCallback() {
  const { createApp } = await import('../../src/app.js');
  const app = await createApp();
  await app.ready();
  const response = await app.inject({
    method: 'GET',
    url: '/auth/callback/google?code=provider-code&state=state-token',
    cookies: { [SOCIAL_STATE_COOKIE_NAME]: app.signCookie(TEST_NONCE) },
  });
  await app.close();
  return response;
}

describe('GET /auth/callback/:provider workspace selection', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    process.env.CONFIG_JWKS_URL = 'https://auth.example.com/.well-known/jwks.json';
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret';
    delete process.env.DATABASE_URL;

    readConfigJwtFromTrustedSourceMock.mockReset().mockResolvedValue('config-jwt');
    verifyConfigJwtSignatureMock.mockReset().mockResolvedValue({} as JWTPayload);
    validateConfigFieldsMock.mockReset().mockReturnValue(baseConfig());
    assertConfigDomainMatchesConfigUrlMock.mockReset();
    assertSocialProviderAllowedMock.mockReset();
    getGoogleProfileFromCodeMock.mockReset().mockResolvedValue({
      provider: 'google',
      email: 'user@gmail.com',
      emailVerified: true,
      name: 'User',
      avatarUrl: null,
    });
    verifySocialStateMock.mockReset().mockResolvedValue({
      provider: 'google',
      config_url: CONFIG_URL,
      redirect_url: REDIRECT_URL,
      nonce: TEST_NONCE,
    });
    loginWithSocialProfileMock.mockReset().mockResolvedValue({
      status: 'authenticated',
      userId: 'user-1',
      credentialEpoch: 0,
      twoFaEnabled: false,
    });
    resolveTwoFaPolicyMock.mockReset().mockResolvedValue('OFF');
    signLoginSessionMock.mockReset().mockResolvedValue('login_token_abc');
    buildWorkspaceChoicesMock.mockReset().mockResolvedValue({
      teams: [{ teamId: 'team-1', orgId: 'org-1', name: 'Solo', role: 'owner' }],
      pending_invites: [],
      can_create_org: false,
    });
    finalizeAuthenticatedUserMock.mockReset().mockResolvedValue({
      status: 'granted',
      code: 'abc123',
      redirectTo: `${REDIRECT_URL}?code=abc123`,
    });
    startTwoFactorSetupMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the chooser and PKCE context for multiple ACTIVE teams', async () => {
    verifySocialStateMock.mockResolvedValue({
      provider: 'google',
      config_url: CONFIG_URL,
      redirect_url: REDIRECT_URL,
      nonce: TEST_NONCE,
      code_challenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      code_challenge_method: 'S256',
    });
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' },
        { teamId: 'team-2', orgId: 'org-1', name: 'Engineering', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    const response = await runCallback();

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:3000/auth');
    expect(location.searchParams.get('flow')).toBe('workspace_chooser');
    expect(location.searchParams.get('login_token')).toBe('login_token_abc');
    expect(location.searchParams.get('code_challenge')).toBe(
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    );
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
  });

  it('omits chooser PKCE parameters when the social state carries none', async () => {
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' },
        { teamId: 'team-2', orgId: 'org-1', name: 'Engineering', role: 'owner' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    const response = await runCallback();

    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('flow')).toBe('workspace_chooser');
    expect(location.searchParams.has('code_challenge')).toBe(false);
    expect(location.searchParams.has('code_challenge_method')).toBe(false);
  });

  it('binds the sole ACTIVE team to the authorization-code finalizer', async () => {
    const response = await runCallback();

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${REDIRECT_URL}?code=abc123`);
    expect(signLoginSessionMock).not.toHaveBeenCalled();
    expect(finalizeAuthenticatedUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      expect.anything(),
    );
  });

  it('carries the auto-selected workspace through social 2FA', async () => {
    loginWithSocialProfileMock.mockResolvedValue({
      status: 'authenticated',
      userId: 'user-1',
      credentialEpoch: 0,
      twoFaEnabled: true,
    });
    resolveTwoFaPolicyMock.mockResolvedValue('OPTIONAL');

    const response = await runCallback();

    const token = new URL(response.headers.location as string).searchParams.get('twofa_token');
    expect(token).toBeTruthy();
    const challenge = await verifyTwoFaChallenge({
      token: token as string,
      sharedSecret: process.env.SHARED_SECRET as string,
      audience: process.env.AUTH_SERVICE_IDENTIFIER as string,
    });
    expect(challenge).toMatchObject({ orgId: 'org-1', teamId: 'team-1' });
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });

  it('carries the auto-selected workspace into required 2FA enrollment', async () => {
    resolveTwoFaPolicyMock.mockResolvedValue('REQUIRED');
    startTwoFactorSetupMock.mockResolvedValue({
      setup_token: 'setup-token',
      otpauth_uri: 'otpauth://totp/test',
      qr_svg: '<svg/>',
      manual_secret: 'secret',
    });

    const response = await runCallback();

    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('twofa_enroll_required')).toBe('true');
    expect(location.searchParams.get('twofa_setup_token')).toBe('setup-token');
    expect(startTwoFactorSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        finalize: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
      }),
      expect.anything(),
    );
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });

  it('preserves the chooser when the sole team is accompanied by an invite', async () => {
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [{ teamId: 'team-1', orgId: 'org-1', name: 'Solo', role: 'owner' }],
      pending_invites: [{ inviteId: 'invite-1', teamName: 'Invited Team', invitedBy: 'Alice' }],
      can_create_org: false,
    });

    const response = await runCallback();

    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('flow')).toBe('workspace_chooser');
    expect(location.searchParams.get('login_token')).toBe('login_token_abc');
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });

  it('preserves the chooser for a zero-team user who can create a workspace', async () => {
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [],
      pending_invites: [],
      can_create_org: true,
    });

    const response = await runCallback();

    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('flow')).toBe('workspace_chooser');
    expect(location.searchParams.get('login_token')).toBe('login_token_abc');
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).not.toHaveBeenCalled();
  });

  it('leaves the code unscoped when workspace selection is off', async () => {
    validateConfigFieldsMock.mockReturnValue(
      baseConfig({
        login_flow: { email_code_enabled: false, workspace_selection: 'off' },
      }),
    );

    const response = await runCallback();

    expect(response.headers.location).toBe(`${REDIRECT_URL}?code=abc123`);
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
    expect(signLoginSessionMock).not.toHaveBeenCalled();
    const finalizeParams = finalizeAuthenticatedUserMock.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalizeParams).not.toHaveProperty('orgId');
    expect(finalizeParams).not.toHaveProperty('teamId');
  });
});
