import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, getEnv, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { buildAppleAuthorizationUrl } from '../../services/social/apple.service.js';
import { buildFacebookAuthorizationUrl } from '../../services/social/facebook.service.js';
import { buildGitHubAuthorizationUrl } from '../../services/social/github.service.js';
import { buildGoogleAuthorizationUrl } from '../../services/social/google.service.js';
import { buildLinkedInAuthorizationUrl } from '../../services/social/linkedin.service.js';
import { assertSocialProviderAllowed } from '../../services/social/index.js';
import { signSocialState } from '../../services/social/social-state.service.js';
import {
  generateSocialStateNonce,
  setSocialStateCookie,
} from '../../services/social/social-state-cookie.js';
import type { SocialProviderKey } from '../../services/social/provider.base.js';
import { parseRequestAccessFlag } from '../../services/access-request-flow.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { configFetchRateLimiter } from './rate-limit-keys.js';

const ParamsSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github', 'linkedin']),
});

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    redirect_url: z.string().min(1).max(2048).optional(),
    redirect_uri: z.string().min(1).max(2048).optional(),
    code_challenge: z.string().min(1).max(256).optional(),
    code_challenge_method: z.string().min(1).max(32).optional(),
    request_access: z.string().max(16).optional(),
  })
  .strict();

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function resolvePublicBaseUrl(): string {
  const env = getEnv();
  return env.PUBLIC_BASE_URL ? normalizeBaseUrl(env.PUBLIC_BASE_URL) : `http://${env.HOST}:${env.PORT}`;
}

function redirectNoStore(reply: FastifyReply, url: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.redirect(url, 302);
}

export function registerAuthSocialRoute(app: FastifyInstance): void {
  app.get(
    '/auth/social/:provider',
    {
      preHandler: [configFetchRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { provider } = ParamsSchema.parse(request.params);
      const { redirect_url, redirect_uri, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);

      const config = request.config;
      if (!config || !request.configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      assertSocialProviderAllowed({ config, provider });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url ?? redirect_uri,
      });
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      const env = getEnv();

      // Bind the OAuth `state` to this browser: a CSPRNG nonce is embedded in the
      // signed state JWT and mirrored in an HttpOnly cookie. The callback rejects
      // unless both match, preventing login-CSRF / forced-login attacks. Generated
      // once and reused across provider branches; the cookie is set on `reply` here
      // and verified in the callback route.
      const nonce = generateSocialStateNonce();
      const baseUrl = resolvePublicBaseUrl();
      const authServiceIdentifier = getAuthServiceIdentifier(env);
      const requestConfigUrl = request.configUrl;

      const signStateForProvider = async (
        providerKey: SocialProviderKey,
      ): Promise<string> => {
        const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
        const state = await signSocialState({
          provider: providerKey,
          configUrl: requestConfigUrl,
          redirectUrl,
          requestAccess: parseRequestAccessFlag(request_access),
          codeChallenge: pkce.codeChallenge,
          codeChallengeMethod: pkce.codeChallengeMethod,
          nonce,
          sharedSecret: SHARED_SECRET,
          audience: authServiceIdentifier,
          baseUrlForIssuer: baseUrl,
        });
        setSocialStateCookie(reply, nonce);
        return state;
      };

      if (provider === 'google') {
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'GOOGLE_ENV_MISSING');
        }

        const redirectUri = `${baseUrl}/auth/callback/google`;
        const state = await signStateForProvider('google');

        const url = buildGoogleAuthorizationUrl({
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri,
          state,
        });
        redirectNoStore(reply, url);
        return;
      }

      if (provider === 'facebook') {
        if (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'FACEBOOK_ENV_MISSING');
        }

        const redirectUri = `${baseUrl}/auth/callback/facebook`;
        const state = await signStateForProvider('facebook');

        const url = buildFacebookAuthorizationUrl({
          clientId: env.FACEBOOK_CLIENT_ID,
          redirectUri,
          state,
        });
        redirectNoStore(reply, url);
        return;
      }

      if (provider === 'github') {
        if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'GITHUB_ENV_MISSING');
        }

        const redirectUri = `${baseUrl}/auth/callback/github`;
        const state = await signStateForProvider('github');

        const url = buildGitHubAuthorizationUrl({
          clientId: env.GITHUB_CLIENT_ID,
          redirectUri,
          state,
        });
        redirectNoStore(reply, url);
        return;
      }

      if (provider === 'apple') {
        if (
          !env.APPLE_CLIENT_ID ||
          !env.APPLE_TEAM_ID ||
          !env.APPLE_KEY_ID ||
          !env.APPLE_PRIVATE_KEY
        ) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'APPLE_ENV_MISSING');
        }

        const redirectUri = `${baseUrl}/auth/callback/apple`;
        const state = await signStateForProvider('apple');

        const url = buildAppleAuthorizationUrl({
          clientId: env.APPLE_CLIENT_ID,
          redirectUri,
          state,
        });
        redirectNoStore(reply, url);
        return;
      }

      if (provider === 'linkedin') {
        if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'LINKEDIN_ENV_MISSING');
        }

        const redirectUri = `${baseUrl}/auth/callback/linkedin`;
        const state = await signStateForProvider('linkedin');

        const url = buildLinkedInAuthorizationUrl({
          clientId: env.LINKEDIN_CLIENT_ID,
          redirectUri,
          state,
        });
        redirectNoStore(reply, url);
        return;
      }

      // Defensive: schema restricts this; keep generic.
      throw new AppError('BAD_REQUEST', 400);
    },
  );
}
