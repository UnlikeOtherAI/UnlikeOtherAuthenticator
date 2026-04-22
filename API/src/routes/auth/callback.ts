import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, getEnv, requireEnv } from '../../config/env.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { AppError } from '../../utils/errors.js';
import {
  assertConfigDomainMatchesConfigUrl,
  validateConfigFields,
  verifyConfigJwtSignature,
} from '../../services/config.service.js';
import { readConfigJwtFromTrustedSource } from '../../services/config-jwt-source.service.js';
import { assertSocialProviderAllowed } from '../../services/social/index.js';
import { getAppleProfileFromCode } from '../../services/social/apple.service.js';
import { getFacebookProfileFromCode } from '../../services/social/facebook.service.js';
import { getGitHubProfileFromCode } from '../../services/social/github.service.js';
import { getGoogleProfileFromCode } from '../../services/social/google.service.js';
import { getLinkedInProfileFromCode } from '../../services/social/linkedin.service.js';
import type { SocialProfile } from '../../services/social/provider.base.js';
import { loginWithSocialProfile } from '../../services/social/social-login.service.js';
import { verifySocialState } from '../../services/social/social-state.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { finalizeAuthenticatedUser } from '../../services/access-request-flow.service.js';
import { requestRegistrationInstructions } from '../../services/auth-register.service.js';
import { signTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { socialCallbackRateLimiter } from './rate-limit-keys.js';

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
  return env.PUBLIC_BASE_URL
    ? normalizeBaseUrl(env.PUBLIC_BASE_URL)
    : `http://${env.HOST}:${env.PORT}`;
}

function socialStateIssuer(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/social-state`;
}

function buildAuthFailedRedirectUrl(redirectUrl: string): string {
  const u = new URL(redirectUrl);
  u.searchParams.set('error', 'auth_failed');
  return u.toString();
}

function redirectNoStore(reply: FastifyReply, url: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.redirect(url, 302);
}

export function registerAuthCallbackRoute(app: FastifyInstance): void {
  app.get(
    '/auth/callback/:provider',
    { preHandler: [socialCallbackRateLimiter] },
    async (request, reply) => {
      const { provider } = ParamsSchema.parse(request.params);
      const { code, state, error } = QuerySchema.parse(request.query);

      // Any provider error is a generic auth failure. Don't leak specifics.
      if (error) {
        throw new AppError('UNAUTHORIZED', 401, 'SOCIAL_PROVIDER_ERROR');
      }

      if (!code || !state) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_SOCIAL_CALLBACK_PARAMS');
      }

      const { SHARED_SECRET, CONFIG_JWKS_URL } = requireEnv(
        'SHARED_SECRET',
        'CONFIG_JWKS_URL',
      );
      const authServiceIdentifier = getAuthServiceIdentifier();
      const baseUrl = resolvePublicBaseUrl();

      const socialState = await verifySocialState({
        stateJwt: state,
        sharedSecret: SHARED_SECRET,
        audience: authServiceIdentifier,
        issuer: socialStateIssuer(baseUrl),
      });

      if (socialState.provider !== provider) {
        throw new AppError('BAD_REQUEST', 400, 'SOCIAL_PROVIDER_MISMATCH');
      }

      const configUrl = socialState.config_url;
      const requestedRedirectUrl = socialState.redirect_url;

      // Brief 22.1 + 22.4: fetch and verify config on each auth initiation.
      const configJwt = await readConfigJwtFromTrustedSource(configUrl);
      const payload = await verifyConfigJwtSignature(
        configJwt,
        CONFIG_JWKS_URL,
      );
      const config = validateConfigFields(payload);
      assertConfigDomainMatchesConfigUrl(config.domain, configUrl);
      assertSocialProviderAllowed({ config, provider });

      // configVerifier doesn't run on /auth/callback (the provider redirect is unauthenticated
      // and config_url travels inside `state`). Mirror its contract so setTenantContextFromRequest
      // can read the verified domain below.
      request.config = config;
      request.configUrl = configUrl;

      // Re-validate redirect URL against current config (config can change between initiation and callback).
      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl,
      });

      const env = getEnv();

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

      setTenantContextFromRequest(request, { orgId: null, userId: null });

      const outcome = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);

        if (!profile.emailVerified) {
          await requestRegistrationInstructions(
            {
              email: profile.email,
              config,
              configUrl,
              redirectUrl,
              requestAccess: socialState.request_access === true,
              codeChallenge: socialState.code_challenge,
              codeChallengeMethod: socialState.code_challenge_method,
            },
            { prisma },
          );
          return { kind: 'auth_failed' as const };
        }

        const socialLoginResult = await loginWithSocialProfile(
          {
            profile,
            config,
            requestAccess: socialState.request_access === true,
          },
          { prisma },
        );

        if (socialLoginResult.status === 'blocked') {
          return { kind: 'auth_failed' as const };
        }

        const { userId, twoFaEnabled } = socialLoginResult;
        const rememberMe = config.session?.remember_me_default ?? true;

        if (config['2fa_enabled'] && twoFaEnabled) {
          const twofa_token = await signTwoFaChallenge({
            userId,
            domain: config.domain,
            configUrl,
            redirectUrl,
            authMethod: provider,
            rememberMe,
            requestAccess: socialState.request_access === true,
            codeChallenge: socialState.code_challenge,
            codeChallengeMethod: socialState.code_challenge_method,
            sharedSecret: SHARED_SECRET,
            audience: authServiceIdentifier,
          });
          return { kind: 'twofa' as const, twofa_token };
        }

        const finalResult = await finalizeAuthenticatedUser(
          {
            userId,
            config,
            configUrl,
            redirectUrl,
            rememberMe,
            requestAccess: socialState.request_access === true,
            codeChallenge: socialState.code_challenge,
            codeChallengeMethod: socialState.code_challenge_method,
          },
          { prisma },
        );

        try {
          await recordLoginLog(
            {
              userId,
              email: profile.email,
              domain: config.domain,
              authMethod: provider,
              ip: request.ip ?? null,
              userAgent:
                typeof request.headers['user-agent'] === 'string'
                  ? request.headers['user-agent']
                  : null,
            },
            { prisma },
          );
        } catch (err) {
          request.log.error({ err }, 'failed to record login log');
        }

        return { kind: 'granted' as const, finalResult };
      });

      if (outcome.kind === 'auth_failed') {
        redirectNoStore(reply, buildAuthFailedRedirectUrl(redirectUrl));
        return;
      }

      if (outcome.kind === 'twofa') {
        const u = new URL(`${baseUrl}/auth`);
        u.searchParams.set('config_url', configUrl);
        u.searchParams.set('redirect_url', redirectUrl);
        u.searchParams.set('twofa_token', outcome.twofa_token);
        if (socialState.request_access === true) {
          u.searchParams.set('request_access', 'true');
        }
        redirectNoStore(reply, u.toString());
        return;
      }

      redirectNoStore(reply, outcome.finalResult.redirectTo);
    },
  );
}
