import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const validateRegistrationEmailLandingTokenMock = vi.fn();
const verifyEmailTokenMock = vi.fn();
const buildWorkspaceChoicesMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const startTwoFactorSetupMock = vi.fn();
const finalizeAuthenticatedUserMock = vi.fn();

let currentConfig: ClientConfig;

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
    request.config = currentConfig;
  },
}));

vi.mock('../../src/services/auth-registration-email-link.service.js', () => ({
  validateRegistrationEmailLandingToken: (...args: unknown[]) =>
    validateRegistrationEmailLandingTokenMock(...args),
}));

vi.mock('../../src/services/auth-verify-email.service.js', () => ({
  verifyEmailToken: (...args: unknown[]) => verifyEmailTokenMock(...args),
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

vi.mock('../../src/services/twofactor-policy.service.js', () => ({
  resolveTwoFaPolicy: (...args: unknown[]) => resolveTwoFaPolicyMock(...args),
}));

vi.mock('../../src/services/twofactor-setup.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/twofactor-setup.service.js')
  >('../../src/services/twofactor-setup.service.js');
  return {
    ...actual,
    startTwoFactorSetup: (...args: unknown[]) => startTwoFactorSetupMock(...args),
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

function config(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: ['https://client.example.com/oauth/callback'],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
    user_scope: 'global',
    allow_registration: true,
    registration_mode: 'passwordless',
    '2fa_enabled': true,
    debug_enabled: false,
    login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    access_requests: { enabled: false, notify_org_roles: ['owner', 'admin'] },
  } as ClientConfig;
}

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
        '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' +
        '&code_challenge_method=S256' +
        '&token=valid-login-link-token',
    });
  } finally {
    await app.close();
  }
}

describe('GET /auth/email/link exact-one workspace 2FA', () => {
  beforeEach(() => {
    currentConfig = config();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
    validateRegistrationEmailLandingTokenMock.mockReset().mockResolvedValue('LOGIN_LINK');
    verifyEmailTokenMock.mockReset().mockResolvedValue({
      userId: 'user-1',
      twoFaEnabled: true,
      acceptedInvite: null,
    });
    buildWorkspaceChoicesMock.mockReset().mockResolvedValue({
      teams: [
        {
          teamId: 'team-1',
          orgId: 'org-1',
          name: 'Solo',
          slug: 'solo',
          role: 'owner',
          iconUrl: null,
        },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    resolveTwoFaPolicyMock.mockReset().mockResolvedValue('OPTIONAL');
    startTwoFactorSetupMock.mockReset();
    finalizeAuthenticatedUserMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects with a challenge that carries the exact workspace', async () => {
    const response = await getLink();

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string, 'http://localhost');
    expect(location.pathname).toBe('/auth');
    const token = location.searchParams.get('twofa_token');
    expect(token).toBeTruthy();
    const challenge = await verifyTwoFaChallenge({
      token: token as string,
      sharedSecret: process.env.SHARED_SECRET as string,
      audience: process.env.AUTH_SERVICE_IDENTIFIER as string,
    });
    expect(challenge).toMatchObject({ orgId: 'org-1', teamId: 'team-1' });
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });

  it('redirects required enrollment with the exact workspace in setup finalization', async () => {
    verifyEmailTokenMock.mockResolvedValue({
      userId: 'user-1',
      twoFaEnabled: false,
      acceptedInvite: null,
    });
    resolveTwoFaPolicyMock.mockResolvedValue('REQUIRED');
    startTwoFactorSetupMock.mockResolvedValue({
      setup_token: 'setup-token',
      otpauth_uri: 'otpauth://totp/test',
      qr_svg: '<svg/>',
      manual_secret: 'secret',
    });

    const response = await getLink();

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string, 'http://localhost');
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
});
