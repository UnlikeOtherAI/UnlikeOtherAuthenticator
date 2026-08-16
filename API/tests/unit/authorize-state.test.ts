import { describe, expect, it } from 'vitest';

import { buildRedirectToUrl } from '../../src/services/authorization-code.service.js';
import type { ClientConfig } from '../../src/services/config.service.js';
import {
  assertLoginSessionContinuation,
  signLoginSession,
  verifyLoginSession,
} from '../../src/services/login-session.service.js';
import {
  signTwoFaChallenge,
  verifyTwoFaChallenge,
} from '../../src/services/twofactor-challenge.service.js';
import {
  signTwoFaSetupToken,
  verifyTwoFaSetupToken,
} from '../../src/services/twofactor-setup-token.service.js';
import {
  signSocialState,
  verifySocialState,
} from '../../src/services/social/social-state.service.js';
import { testUiTheme } from '../helpers/test-config.js';

const SECRET = 'test-shared-secret-with-enough-length';
const AUDIENCE = 'uoa:login-session';
const CONFIG_URL = 'https://client.example.com/auth-config';
const REDIRECT_URL = 'https://client.example.com/oauth/callback';
const CHALLENGE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const STATE = 'rp-opaque-state-4f2b91';

function config(): ClientConfig {
  return {
    domain: 'client.example.com',
    redirect_urls: [REDIRECT_URL],
    enabled_auth_methods: ['email_password'],
    ui_theme: testUiTheme(),
    language_config: 'en',
  } as ClientConfig;
}

function continuation(overrides?: Record<string, unknown>) {
  return {
    userId: 'user-1',
    credentialEpoch: 0,
    authMethod: 'email_password',
    config: config(),
    configUrl: CONFIG_URL,
    redirectUrl: REDIRECT_URL,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256' as const,
    rememberMe: true,
    requestAccess: false,
    sharedSecret: SECRET,
    audience: AUDIENCE,
    ...overrides,
  };
}

describe('authorize state — redirect echo', () => {
  it('echoes the opaque state alongside the code', () => {
    const url = new URL(
      buildRedirectToUrl({ redirectUrl: REDIRECT_URL, code: 'code-1', state: STATE }),
    );
    expect(url.searchParams.get('code')).toBe('code-1');
    expect(url.searchParams.get('state')).toBe(STATE);
  });

  it('is byte-identical to the pre-state redirect when the caller sent none', () => {
    const withoutParam = buildRedirectToUrl({ redirectUrl: REDIRECT_URL, code: 'code-1' });
    for (const absent of [undefined, null, '']) {
      expect(buildRedirectToUrl({ redirectUrl: REDIRECT_URL, code: 'code-1', state: absent })).toBe(
        withoutParam,
      );
    }
    expect(new URL(withoutParam).searchParams.has('state')).toBe(false);
  });

  it('does not let state displace or forge the code', () => {
    const url = new URL(
      buildRedirectToUrl({
        redirectUrl: REDIRECT_URL,
        code: 'real-code',
        state: 'x&code=forged',
      }),
    );
    expect(url.searchParams.getAll('code')).toEqual(['real-code']);
    expect(url.searchParams.get('state')).toBe('x&code=forged');
  });

  it('preserves query already present on the registered redirect URL', () => {
    const url = new URL(
      buildRedirectToUrl({
        redirectUrl: `${REDIRECT_URL}?tenant=acme`,
        code: 'code-1',
        state: STATE,
      }),
    );
    expect(url.searchParams.get('tenant')).toBe('acme');
    expect(url.searchParams.get('state')).toBe(STATE);
  });
});

describe('authorize state — bound to the login session', () => {
  it('round-trips the state through the signed chooser capability', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation({ state: STATE }), now });
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    expect(session.state).toBe(STATE);
  });

  it('carries no state when the relying party sent none', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation(), now });
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    expect(session.state).toBeUndefined();
  });

  it('refuses a later hop that presents a different state', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation({ state: STATE }), now });
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    expect(() =>
      assertLoginSessionContinuation(session, {
        redirectUrl: REDIRECT_URL,
        state: 'attacker-supplied-state',
        requestAccess: false,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).toThrowError();
  });

  it('refuses a state injected into a login that had none', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation(), now });
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    expect(() =>
      assertLoginSessionContinuation(session, {
        redirectUrl: REDIRECT_URL,
        state: 'injected',
        requestAccess: false,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).toThrowError();
  });

  it('accepts a hop that omits state — the signed value stays authoritative', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const token = await signLoginSession({ ...continuation({ state: STATE }), now });
    const session = await verifyLoginSession({
      token,
      config: config(),
      configUrl: CONFIG_URL,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });

    expect(() =>
      assertLoginSessionContinuation(session, {
        redirectUrl: REDIRECT_URL,
        requestAccess: false,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).not.toThrow();
    expect(session.state).toBe(STATE);
  });
});

describe('authorize state — bound to every bridge token', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  it('survives the 2FA challenge bridge', async () => {
    const token = await signTwoFaChallenge({
      userId: 'user-1',
      credentialEpoch: 0,
      configUrl: CONFIG_URL,
      redirectUrl: REDIRECT_URL,
      state: STATE,
      domain: 'client.example.com',
      authMethod: 'email_password',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    const challenge = await verifyTwoFaChallenge({
      token,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    expect(challenge.state).toBe(STATE);
  });

  it('survives the 2FA enrolment bridge', async () => {
    const token = await signTwoFaSetupToken({
      userId: 'user-1',
      credentialEpoch: 0,
      encryptedSecret: 'enc',
      configUrl: CONFIG_URL,
      domain: 'client.example.com',
      redirectUrl: REDIRECT_URL,
      state: STATE,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    const setup = await verifyTwoFaSetupToken({
      token,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    expect(setup.state).toBe(STATE);
  });

  it('survives the social provider round-trip', async () => {
    const baseUrl = 'https://auth.example.com';
    const stateJwt = await signSocialState({
      provider: 'google',
      configUrl: CONFIG_URL,
      redirectUrl: REDIRECT_URL,
      state: STATE,
      nonce: 'nonce-1',
      sharedSecret: SECRET,
      audience: AUDIENCE,
      baseUrlForIssuer: baseUrl,
      now,
    });
    const parsed = await verifySocialState({
      stateJwt,
      sharedSecret: SECRET,
      audience: AUDIENCE,
      issuer: `${baseUrl}/social-state`,
      now,
    });
    expect(parsed.state).toBe(STATE);
  });

  it('leaves every bridge token unchanged when no state was supplied', async () => {
    const challenge = await verifyTwoFaChallenge({
      token: await signTwoFaChallenge({
        userId: 'user-1',
        credentialEpoch: 0,
        configUrl: CONFIG_URL,
        redirectUrl: REDIRECT_URL,
        domain: 'client.example.com',
        authMethod: 'email_password',
        sharedSecret: SECRET,
        audience: AUDIENCE,
        now,
      }),
      sharedSecret: SECRET,
      audience: AUDIENCE,
      now,
    });
    expect(challenge.state).toBeUndefined();
  });
});
