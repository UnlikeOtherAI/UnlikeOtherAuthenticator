import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_SESSION_AUDIENCE } from '../../src/config/constants.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import { verifyTwoFaChallenge } from '../../src/services/twofactor-challenge.service.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;
const pkceQuery =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';

const loginWithEmailPasswordMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const signLoginSessionMock = vi.fn();
const buildWorkspaceChoicesMock = vi.fn();
const finalizeAuthenticatedUserMock = vi.fn();
const resolveProductWorkspaceBeforeTwoFaMock = vi.fn();
const startTwoFactorSetupMock = vi.fn();

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

vi.mock('../../src/services/auth-login.service.js', () => ({
  loginWithEmailPassword: (...args: unknown[]) => loginWithEmailPasswordMock(...args),
}));

vi.mock('../../src/services/twofactor-policy.service.js', () => ({
  resolveTwoFaPolicy: (...args: unknown[]) => resolveTwoFaPolicyMock(...args),
}));

vi.mock('../../src/services/login-session.service.js', () => ({
  signLoginSession: (...args: unknown[]) => signLoginSessionMock(...args),
}));

vi.mock('../../src/services/required-workspace-placement.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/required-workspace-placement.service.js')
  >('../../src/services/required-workspace-placement.service.js');
  return {
    ...actual,
    resolveProductWorkspaceBeforeTwoFa: (...args: unknown[]) =>
      resolveProductWorkspaceBeforeTwoFaMock(...args),
  };
});

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
    '2fa_enabled': false,
    debug_enabled: false,
    ...overrides,
  } as ClientConfig;
}

describe('POST /auth/login — workspace chooser wiring (Phase 3b Task 7)', () => {
  beforeEach(() => {
    currentConfig = baseConfig();
    loginWithEmailPasswordMock.mockReset();
    resolveTwoFaPolicyMock.mockReset().mockResolvedValue('OFF');
    signLoginSessionMock.mockReset();
    buildWorkspaceChoicesMock.mockReset();
    finalizeAuthenticatedUserMock.mockReset();
    resolveProductWorkspaceBeforeTwoFaMock.mockReset().mockResolvedValue(null);
    startTwoFactorSetupMock.mockReset();
    process.env.SHARED_SECRET = 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function postLogin() {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();
    try {
      return await app.inject({
        method: 'POST',
        url: `/auth/login?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config${pkceQuery}`,
        payload: { email: 'user@example.com', password: 'Abcdef1!' },
      });
    } finally {
      await app.close();
    }
  }

  it('workspace_selection "off" (default): behaves exactly like before — no login_token, direct finalize', async () => {
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user-1', twoFaEnabled: false });
    finalizeAuthenticatedUserMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const res = await postLogin();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'auth_code_1',
      redirect_to: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });
    expect(signLoginSessionMock).not.toHaveBeenCalled();
    expect(buildWorkspaceChoicesMock).not.toHaveBeenCalled();
  });

  it('workspace_selection "auto" + 2FA satisfied: returns login_token + chooser instead of finalizing', async () => {
    currentConfig = baseConfig({
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user-1', twoFaEnabled: false });
    signLoginSessionMock.mockResolvedValue('login_token_abc');
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' },
        { teamId: 'team-2', orgId: 'org-2', name: 'Ops', role: 'member' },
      ],
      pending_invites: [],
      can_create_org: false,
    });

    const res = await postLogin();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      login_token: 'login_token_abc',
      teams: [
        { teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' },
        { teamId: 'team-2', orgId: 'org-2', name: 'Ops', role: 'member' },
      ],
      pending_invites: [],
      can_create_org: false,
    });
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
    // Regression guard: the login_token MUST be signed with LOGIN_SESSION_AUDIENCE, the same audience
    // verify-code/select-team/session-choices verify against. Signing it with the auth-service
    // identifier (as this route once did) makes the password → chooser → select-team flow fail
    // token verification.
    expect(signLoginSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ audience: LOGIN_SESSION_AUDIENCE }),
    );
  });

  it('resolves the exact auto-selected workspace before enforcing 2FA', async () => {
    currentConfig = baseConfig({
      '2fa_enabled': true,
      login_flow: { email_code_enabled: false, workspace_selection: 'auto' },
    });
    resolveTwoFaPolicyMock.mockResolvedValue('OPTIONAL');
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user-1', twoFaEnabled: true });
    buildWorkspaceChoicesMock.mockResolvedValue({
      teams: [{ teamId: 'team-1', orgId: 'org-1', name: 'Design', role: 'member' }],
      pending_invites: [],
      can_create_org: false,
    });

    const res = await postLogin();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, twofa_required: true });
    expect(typeof body.twofa_token).toBe('string');
    expect(signLoginSessionMock).not.toHaveBeenCalled();
    expect(buildWorkspaceChoicesMock).toHaveBeenCalled();
    expect(resolveTwoFaPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1' }),
      expect.anything(),
    );
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });

  it('pre-binds a recognized product workspace before enrolled 2FA when the chooser is off', async () => {
    currentConfig = baseConfig({
      '2fa_enabled': true,
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
    });
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user-1', twoFaEnabled: true });
    resolveProductWorkspaceBeforeTwoFaMock.mockResolvedValue({
      orgId: 'org-cross',
      teamId: 'team-cross',
    });
    resolveTwoFaPolicyMock.mockResolvedValue('REQUIRED');

    const res = await postLogin();

    expect(res.statusCode).toBe(200);
    const body = res.json() as { twofa_token: string };
    const challenge = await verifyTwoFaChallenge({
      token: body.twofa_token,
      sharedSecret: process.env.SHARED_SECRET as string,
      audience: process.env.AUTH_SERVICE_IDENTIFIER as string,
    });
    expect(challenge).toMatchObject({ orgId: 'org-cross', teamId: 'team-cross' });
    expect(resolveTwoFaPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-cross' }),
      expect.anything(),
    );
  });

  it('pre-binds a recognized product workspace before required enrollment when chooser is off', async () => {
    currentConfig = baseConfig({
      '2fa_enabled': true,
      login_flow: { email_code_enabled: false, workspace_selection: 'off' },
    });
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user-1', twoFaEnabled: false });
    resolveProductWorkspaceBeforeTwoFaMock.mockResolvedValue({
      orgId: 'org-cross',
      teamId: 'team-cross',
    });
    resolveTwoFaPolicyMock.mockResolvedValue('REQUIRED');
    startTwoFactorSetupMock.mockResolvedValue({
      setup_token: 'setup-token',
      otpauth_uri: 'otpauth://totp/test',
      qr_svg: '<svg/>',
      manual_secret: 'secret',
    });

    const res = await postLogin();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'twofa_enroll_required',
      setup_token: 'setup-token',
    });
    expect(startTwoFactorSetupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        finalize: expect.objectContaining({ orgId: 'org-cross', teamId: 'team-cross' }),
      }),
      expect.anything(),
    );
    expect(finalizeAuthenticatedUserMock).not.toHaveBeenCalled();
  });
});
