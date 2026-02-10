import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientConfig } from '../../src/services/config.service.js';
import { testUiTheme } from '../helpers/test-config.js';

let currentConfig: ClientConfig | null = null;

const loginWithEmailPasswordMock = vi.fn();
const issueAuthorizationCodeMock = vi.fn();
const buildRedirectToUrlMock = vi.fn();
const signTwoFaChallengeMock = vi.fn();
const verifyTwoFaChallengeMock = vi.fn();
const verifyTwoFactorForLoginMock = vi.fn();

vi.mock('../../src/middleware/config-verifier.js', () => {
  return {
    configVerifier: async (request: { query?: { config_url?: string }; configUrl?: string; config?: ClientConfig }): Promise<void> => {
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

vi.mock('../../src/services/token.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/token.service.js')>(
    '../../src/services/token.service.js',
  );
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
    verifyTwoFactorForLoginMock.mockReset();

    process.env.SHARED_SECRET = process.env.SHARED_SECRET ?? 'test-shared-secret';
    process.env.AUTH_SERVICE_IDENTIFIER =
      process.env.AUTH_SERVICE_IDENTIFIER ?? 'uoa-auth-service';
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
      url: '/auth/login?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
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
      url: '/auth/login?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config',
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
    expect(res.json()).toEqual({ error: 'Request failed' });

    expect(verifyTwoFaChallengeMock).not.toHaveBeenCalled();
    expect(verifyTwoFactorForLoginMock).not.toHaveBeenCalled();

    await app.close();
  });
});
