import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv, requireEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import {
  assertConfigDomainMatchesConfigUrl,
  fetchConfigJwtFromUrl,
  validateConfigFields,
  verifyConfigJwtSignature,
} from '../../services/config.service.js';
import { assertSocialProviderAllowed } from '../../services/social/index.js';
import { getAppleProfileFromCode } from '../../services/social/apple.service.js';
import { getFacebookProfileFromCode } from '../../services/social/facebook.service.js';
import { getGitHubProfileFromCode } from '../../services/social/github.service.js';
import { getGoogleProfileFromCode } from '../../services/social/google.service.js';
import { getLinkedInProfileFromCode } from '../../services/social/linkedin.service.js';
import type { SocialProfile } from '../../services/social/provider.base.js';
import { loginWithSocialProfile } from '../../services/social/social-login.service.js';
import { verifySocialState } from '../../services/social/social-state.service.js';
import { signTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import {
  buildRedirectToUrl,
  issueAuthorizationCode,
  selectRedirectUrl,
} from '../../services/token.service.js';

const ParamsSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github', 'linkedin']),
});

const QuerySchema = z
  .object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  })
  .passthrough();

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function resolvePublicBaseUrl(): string {
  const env = getEnv();
  return env.PUBLIC_BASE_URL ? normalizeBaseUrl(env.PUBLIC_BASE_URL) : `http://${env.HOST}:${env.PORT}`;
}

export function registerAuthCallbackRoute(app: FastifyInstance): void {
  app.get('/auth/callback/:provider', async (request, reply) => {
    const { provider } = ParamsSchema.parse(request.params);
    const { code, state, error } = QuerySchema.parse(request.query);

    // Any provider error is a generic auth failure. Don't leak specifics.
    if (error) {
      throw new AppError('UNAUTHORIZED', 401, 'SOCIAL_PROVIDER_ERROR');
    }

    if (!code || !state) {
      throw new AppError('BAD_REQUEST', 400, 'MISSING_SOCIAL_CALLBACK_PARAMS');
    }

    const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
      'SHARED_SECRET',
      'AUTH_SERVICE_IDENTIFIER',
    );

    const socialState = await verifySocialState({
      stateJwt: state,
      sharedSecret: SHARED_SECRET,
      audience: AUTH_SERVICE_IDENTIFIER,
    });

    if (socialState.provider !== provider) {
      throw new AppError('BAD_REQUEST', 400, 'SOCIAL_PROVIDER_MISMATCH');
    }

    const configUrl = socialState.config_url;
    const requestedRedirectUrl = socialState.redirect_url;

    // Brief 22.1 + 22.4: fetch and verify config on each auth initiation.
    const configJwt = await fetchConfigJwtFromUrl(configUrl);
    const payload = await verifyConfigJwtSignature(
      configJwt,
      SHARED_SECRET,
      AUTH_SERVICE_IDENTIFIER,
    );
    const config = validateConfigFields(payload);
    assertConfigDomainMatchesConfigUrl(config.domain, configUrl);
    assertSocialProviderAllowed({ config, provider });

    // Re-validate redirect URL against current config (config can change between initiation and callback).
    const redirectUrl = selectRedirectUrl({
      allowedRedirectUrls: config.redirect_urls,
      requestedRedirectUrl,
    });

    const env = getEnv();
    const baseUrl = resolvePublicBaseUrl();

    let profile: SocialProfile;
    if (provider === 'google') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new AppError('INTERNAL', 500, 'GOOGLE_ENV_MISSING');
      }

      const redirectUri = `${baseUrl}/auth/callback/google`;
      profile = await getGoogleProfileFromCode({
        code,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri,
      });
    } else if (provider === 'facebook') {
      if (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET) {
        throw new AppError('INTERNAL', 500, 'FACEBOOK_ENV_MISSING');
      }

      const redirectUri = `${baseUrl}/auth/callback/facebook`;
      profile = await getFacebookProfileFromCode({
        code,
        clientId: env.FACEBOOK_CLIENT_ID,
        clientSecret: env.FACEBOOK_CLIENT_SECRET,
        redirectUri,
      });
    } else if (provider === 'github') {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        throw new AppError('INTERNAL', 500, 'GITHUB_ENV_MISSING');
      }

      const redirectUri = `${baseUrl}/auth/callback/github`;
      profile = await getGitHubProfileFromCode({
        code,
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        redirectUri,
      });
    } else if (provider === 'apple') {
      if (
        !env.APPLE_CLIENT_ID ||
        !env.APPLE_TEAM_ID ||
        !env.APPLE_KEY_ID ||
        !env.APPLE_PRIVATE_KEY
      ) {
        throw new AppError('INTERNAL', 500, 'APPLE_ENV_MISSING');
      }

      const redirectUri = `${baseUrl}/auth/callback/apple`;
      profile = await getAppleProfileFromCode({
        code,
        clientId: env.APPLE_CLIENT_ID,
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        privateKeyPem: env.APPLE_PRIVATE_KEY,
        redirectUri,
      });
    } else if (provider === 'linkedin') {
      if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
        throw new AppError('INTERNAL', 500, 'LINKEDIN_ENV_MISSING');
      }

      const redirectUri = `${baseUrl}/auth/callback/linkedin`;
      profile = await getLinkedInProfileFromCode({
        code,
        clientId: env.LINKEDIN_CLIENT_ID,
        clientSecret: env.LINKEDIN_CLIENT_SECRET,
        redirectUri,
      });
    } else {
      throw new AppError('BAD_REQUEST', 400);
    }

    const { userId, twoFaEnabled } = await loginWithSocialProfile({
      profile,
      config,
    });

    // Brief 13 / Phase 8.6 + 8.7: enforce 2FA verification during login when enabled via config.
    if (config['2fa_enabled'] && twoFaEnabled) {
      const twofa_token = await signTwoFaChallenge({
        userId,
        domain: config.domain,
        configUrl,
        redirectUrl,
        sharedSecret: SHARED_SECRET,
        audience: AUTH_SERVICE_IDENTIFIER,
      });

      const u = new URL(`${baseUrl}/auth`);
      u.searchParams.set('config_url', configUrl);
      u.searchParams.set('redirect_url', redirectUrl);
      u.searchParams.set('twofa_token', twofa_token);
      reply.redirect(u.toString(), 302);
      return;
    }

    const { code: authCode } = await issueAuthorizationCode({
      userId,
      domain: config.domain,
      configUrl,
      redirectUrl,
    });

    reply.redirect(buildRedirectToUrl({ redirectUrl, code: authCode }), 302);
  });
}
