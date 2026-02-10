import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv, requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { buildAppleAuthorizationUrl } from '../../services/social/apple.service.js';
import { buildFacebookAuthorizationUrl } from '../../services/social/facebook.service.js';
import { buildGoogleAuthorizationUrl } from '../../services/social/google.service.js';
import { assertSocialProviderAllowed } from '../../services/social/index.js';
import { signSocialState } from '../../services/social/social-state.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';

const ParamsSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook']),
});

const QuerySchema = z
  .object({
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function resolvePublicBaseUrl(): string {
  const env = getEnv();
  return env.PUBLIC_BASE_URL ? normalizeBaseUrl(env.PUBLIC_BASE_URL) : `http://${env.HOST}:${env.PORT}`;
}

export function registerAuthSocialRoute(app: FastifyInstance): void {
  app.get(
    '/auth/social/:provider',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { provider } = ParamsSchema.parse(request.params);
      const { redirect_url } = QuerySchema.parse(request.query);

      const config = request.config;
      if (!config) throw new Error('missing request.config');
      if (!request.configUrl) throw new Error('missing request.configUrl');

      assertSocialProviderAllowed({ config, provider });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });

      const env = getEnv();
      if (provider === 'google') {
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'GOOGLE_ENV_MISSING');
        }

        const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
          'SHARED_SECRET',
          'AUTH_SERVICE_IDENTIFIER',
        );
        const baseUrl = resolvePublicBaseUrl();
        const redirectUri = `${baseUrl}/auth/callback/google`;

        const state = await signSocialState({
          provider: 'google',
          configUrl: request.configUrl,
          redirectUrl,
          sharedSecret: SHARED_SECRET,
          audience: AUTH_SERVICE_IDENTIFIER,
          baseUrlForIssuer: baseUrl,
        });

        const url = buildGoogleAuthorizationUrl({
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri,
          state,
        });
        reply.redirect(url, 302);
        return;
      }

      if (provider === 'facebook') {
        if (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET) {
          // Misconfiguration; keep response generic.
          throw new AppError('INTERNAL', 500, 'FACEBOOK_ENV_MISSING');
        }

        const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
          'SHARED_SECRET',
          'AUTH_SERVICE_IDENTIFIER',
        );
        const baseUrl = resolvePublicBaseUrl();
        const redirectUri = `${baseUrl}/auth/callback/facebook`;

        const state = await signSocialState({
          provider: 'facebook',
          configUrl: request.configUrl,
          redirectUrl,
          sharedSecret: SHARED_SECRET,
          audience: AUTH_SERVICE_IDENTIFIER,
          baseUrlForIssuer: baseUrl,
        });

        const url = buildFacebookAuthorizationUrl({
          clientId: env.FACEBOOK_CLIENT_ID,
          redirectUri,
          state,
        });
        reply.redirect(url, 302);
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

        const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
          'SHARED_SECRET',
          'AUTH_SERVICE_IDENTIFIER',
        );
        const baseUrl = resolvePublicBaseUrl();
        const redirectUri = `${baseUrl}/auth/callback/apple`;

        const state = await signSocialState({
          provider: 'apple',
          configUrl: request.configUrl,
          redirectUrl,
          sharedSecret: SHARED_SECRET,
          audience: AUTH_SERVICE_IDENTIFIER,
          baseUrlForIssuer: baseUrl,
        });

        const url = buildAppleAuthorizationUrl({
          clientId: env.APPLE_CLIENT_ID,
          redirectUri,
          state,
        });
        reply.redirect(url, 302);
        return;
      }

      // Defensive: schema restricts this; keep generic.
      throw new AppError('BAD_REQUEST', 400);
    },
  );
}
