import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { expectJsonError } from '../helpers/error-response.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;
const pkceQuery =
  '&code_challenge=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&code_challenge_method=S256';

const loginWithEmailPasswordMock = vi.fn();
const issueAuthorizationCodeMock = vi.fn();
const buildRedirectToUrlMock = vi.fn();
const signTwoFaChallengeMock = vi.fn();
const verifyTwoFaChallengeMock = vi.fn();
const verifyTwoFaSetupTokenMock = vi.fn();
const verifyTwoFactorForLoginMock = vi.fn();
const enrollTwoFactorForUserMock = vi.fn();
const decryptTwoFaSecretMock = vi.fn();
const resolveTwoFaPolicyMock = vi.fn();
const finalizeConfigAuthorizationWithSignaturesMock = vi.fn();
const resolveProductWorkspaceBeforeTwoFaMock = vi.fn();

vi.mock('../../src/middleware/config-verifier.js', () => {
  return {
    configVerifier: async (request: {
      query?: { config_url?: string };
      configUrl?: string;
      config?: ClientConfig;
    }): Promise<void> => {
      request.configUrl = request.query?.config_url;
      request.config = currentConfig ?? undefined;
    },
  };
});

vi.mock('../../src/services/auth-login.service.js', () => {
  return {
    loginWithEmailPassword: (...args: unknown[]) => loginWithEmailPasswordMock(...args),
  };
});

// issueAuthorizationCode / buildRedirectToUrl moved to authorization-code.service.js in Phase 3a
// (token.service split). The route reaches them through access-request-flow, which imports from the
// new module, so the mock must target authorization-code.service.js.
vi.mock('../../src/services/authorization-code.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/authorization-code.service.js')
  >('../../src/services/authorization-code.service.js');
  return {
    ...actual,
    issueAuthorizationCode: (...args: unknown[]) => issueAuthorizationCodeMock(...args),
    buildRedirectToUrl: (...args: unknown[]) => buildRedirectToUrlMock(...args),
  };
});

vi.mock('../../src/services/twofactor-challenge.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/twofactor-challenge.service.js')
  >('../../src/services/twofactor-challenge.service.js');
  return {
    ...actual,
    signTwoFaChallenge: (...args: unknown[]) => signTwoFaChallengeMock(...args),
    verifyTwoFaChallenge: (...args: unknown[]) => verifyTwoFaChallengeMock(...args),
  };
});

vi.mock('../../src/services/twofactor-login.service.js', () => {
  return {
    verifyTwoFactorForLogin: (...args: unknown[]) => verifyTwoFactorForLoginMock(...args),
  };
});

vi.mock('../../src/services/twofactor-setup-token.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/twofactor-setup-token.service.js')
  >('../../src/services/twofactor-setup-token.service.js');
  return {
    ...actual,
    verifyTwoFaSetupToken: (...args: unknown[]) => verifyTwoFaSetupTokenMock(...args),
  };
});

vi.mock('../../src/services/twofactor-enroll.service.js', () => ({
  enrollTwoFactorForUser: (...args: unknown[]) => enrollTwoFactorForUserMock(...args),
}));

vi.mock('../../src/utils/twofa-secret.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/twofa-secret.js')>(
    '../../src/utils/twofa-secret.js',
  );
  return {
    ...actual,
    decryptTwoFaSecret: (...args: unknown[]) => decryptTwoFaSecretMock(...args),
  };
});

vi.mock('../../src/services/twofactor-policy.service.js', () => {
  return {
    resolveTwoFaPolicy: (...args: unknown[]) => resolveTwoFaPolicyMock(...args),
  };
});

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

vi.mock('../../src/services/signature-continuation.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/signature-continuation.service.js')
  >('../../src/services/signature-continuation.service.js');
  return {
    ...actual,
    finalizeConfigAuthorizationWithSignatures: (...args: unknown[]) =>
      finalizeConfigAuthorizationWithSignaturesMock(...args),
  };
});

describe('2FA gated by config `2fa_enabled`', () => {
  beforeEach(() => {
    currentConfig = {
      domain: 'client.example.com',
      redirect_urls: ['https://client.example.com/oauth/callback'],
      enabled_auth_methods: ['email_password'],
      ui_theme: testUiTheme(),
      language_config: 'en',
      user_scope: 'global',
      '2fa_enabled': false,
      debug_enabled: false,
    };

    loginWithEmailPasswordMock.mockReset();
    issueAuthorizationCodeMock.mockReset();
    buildRedirectToUrlMock.mockReset();
    signTwoFaChallengeMock.mockReset();
    verifyTwoFaChallengeMock.mockReset();
    verifyTwoFaSetupTokenMock.mockReset();
    verifyTwoFactorForLoginMock.mockReset();
    enrollTwoFactorForUserMock.mockReset();
    decryptTwoFaSecretMock.mockReset();
    resolveTwoFaPolicyMock.mockReset();
    finalizeConfigAuthorizationWithSignaturesMock.mockReset();
    resolveProductWorkspaceBeforeTwoFaMock.mockReset().mockResolvedValue(null);
    resolveTwoFaPolicyMock.mockImplementation(
      ({ config }: { config: Pick<ClientConfig, '2fa_enabled'> }) =>
        config['2fa_enabled'] === true ? 'OPTIONAL' : 'OFF',
    );
    finalizeConfigAuthorizationWithSignaturesMock.mockImplementation(async () => {
      const issued = await issueAuthorizationCodeMock();
      return {
        status: 'granted',
        code: issued.code,
        redirectTo: buildRedirectToUrlMock(),
      };
    });

    process.env.SHARED_SECRET =
      process.env.SHARED_SECRET ?? 'test-shared-secret-with-enough-length';
    process.env.AUTH_SERVICE_IDENTIFIER = process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not require 2FA when config disables it, even if the user has 2FA enabled', async () => {
    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user_1', twoFaEnabled: true });
    issueAuthorizationCodeMock.mockResolvedValue({ code: 'auth_code_1' });
    buildRedirectToUrlMock.mockReturnValue(
      'https://client.example.com/oauth/callback?code=auth_code_1',
    );

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config${pkceQuery}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      code: 'auth_code_1',
      redirect_to: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    expect(signTwoFaChallengeMock).not.toHaveBeenCalled();
    expect(issueAuthorizationCodeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('requires 2FA only when config enables it and the user has 2FA enabled', async () => {
    currentConfig['2fa_enabled'] = true;

    loginWithEmailPasswordMock.mockResolvedValue({ userId: 'user_1', twoFaEnabled: true });
    signTwoFaChallengeMock.mockResolvedValue('twofa_token_1');

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/auth/login?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config${pkceQuery}`,
      payload: { email: 'user@example.com', password: 'Abcdef1!' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      twofa_required: true,
      twofa_token: 'twofa_token_1',
    });

    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();
    expect(signTwoFaChallengeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejects /2fa/verify when config disables 2FA', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/2fa/verify?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      payload: { twofa_token: 'ignored', code: '123456' },
    });

    expect(res.statusCode).toBe(401);
    expectJsonError(res.json());

    expect(verifyTwoFaChallengeMock).not.toHaveBeenCalled();
    expect(verifyTwoFactorForLoginMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('carries an auto-selected workspace from the 2FA challenge into final code issuance', async () => {
    currentConfig['2fa_enabled'] = true;
    verifyTwoFaChallengeMock.mockResolvedValue({
      userId: 'user_1',
      configUrl: 'https://client.example.com/auth-config',
      redirectUrl: 'https://client.example.com/oauth/callback',
      domain: 'client.example.com',
      authMethod: 'google',
      rememberMe: true,
      requestAccess: false,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      orgId: 'org_1',
      teamId: 'team_1',
    });
    verifyTwoFactorForLoginMock.mockResolvedValue(undefined);
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/2fa/verify?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      payload: { twofa_token: 'twofa_token_1', code: '123456' },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org_1',
        teamId: 'team_1',
        twoFaCompleted: true,
      }),
      expect.objectContaining({ workspacePrisma: expect.anything() }),
    );

    await app.close();
  });

  it('carries an auto-selected workspace from required enrollment into final code issuance', async () => {
    currentConfig['2fa_enabled'] = true;
    resolveTwoFaPolicyMock.mockResolvedValue('REQUIRED');
    verifyTwoFaSetupTokenMock.mockResolvedValue({
      userId: 'user_1',
      encryptedSecret: 'encrypted-secret',
      configUrl: 'https://client.example.com/auth-config',
      domain: 'client.example.com',
      authMethod: 'google',
      redirectUrl: 'https://client.example.com/oauth/callback',
      rememberMe: true,
      requestAccess: false,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      codeChallengeMethod: 'S256',
      orgId: 'org_1',
      teamId: 'team_1',
    });
    decryptTwoFaSecretMock.mockReturnValue('TOTPSECRET');
    enrollTwoFactorForUserMock.mockResolvedValue(undefined);
    finalizeConfigAuthorizationWithSignaturesMock.mockResolvedValue({
      status: 'granted',
      code: 'auth_code_1',
      redirectTo: 'https://client.example.com/oauth/callback?code=auth_code_1',
    });

    const { createApp } = await import('../../src/app.js');
    const app = await createApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/2fa/enroll?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
      payload: { setup_token: 'setup_token_1', code: '123456' },
    });

    expect(res.statusCode).toBe(200);
    expect(finalizeConfigAuthorizationWithSignaturesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org_1',
        teamId: 'team_1',
        twoFaCompleted: true,
      }),
      expect.objectContaining({ workspacePrisma: expect.anything() }),
    );

    await app.close();
  });
});
