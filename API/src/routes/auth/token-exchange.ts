import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { AppError } from '../../utils/errors.js';
import {
  exchangeAuthorizationCodeForTokens,
  exchangeRefreshTokenForTokens,
} from '../../services/token.service.js';
import { tokenExchangeRateLimiter } from './rate-limit-keys.js';

const AuthorizationCodeGrantSchema = z
  .object({
    grant_type: z.literal('authorization_code').optional(),
    code: z.string().min(1),
    redirect_url: z.string().min(1),
    code_verifier: z.string().min(1).optional(),
  })
  .strict();

const RefreshTokenGrantSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
  })
  .strict();

type TokenExchangeBody =
  | {
      grant_type?: 'authorization_code';
      code: string;
      redirect_url: string;
      code_verifier?: string;
    }
  | { grant_type: 'refresh_token'; refresh_token: string };

function parseTokenExchangeBody(body: unknown): TokenExchangeBody {
  const refreshGrant = RefreshTokenGrantSchema.safeParse(body);
  if (refreshGrant.success) {
    return refreshGrant.data;
  }

  const authorizationCodeGrant = AuthorizationCodeGrantSchema.safeParse(body);
  if (authorizationCodeGrant.success) {
    return authorizationCodeGrant.data;
  }

  throw new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN_REQUEST');
}

export function registerAuthTokenExchangeRoute(app: FastifyInstance): void {
  // OAuth authorization code exchange. Called by the client backend.
  app.post(
    '/auth/token',
    {
      preHandler: [tokenExchangeRateLimiter, configVerifier, requireDomainHashAuth],
    },
    async (request, reply) => {
      const body = parseTokenExchangeBody(request.body);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const tokenPair =
        body.grant_type === 'refresh_token'
          ? await exchangeRefreshTokenForTokens({
              refreshToken: body.refresh_token,
              config: request.config,
              configUrl: request.configUrl,
            })
          : await exchangeAuthorizationCodeForTokens({
              code: body.code,
              config: request.config,
              configUrl: request.configUrl,
              redirectUrl: body.redirect_url,
              codeVerifier: body.code_verifier,
            });

      // Keep response OAuth-ish without being overly strict about fields.
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.status(200).send({
        access_token: tokenPair.accessToken,
        expires_in: tokenPair.expiresInSeconds,
        refresh_token: tokenPair.refreshToken,
        refresh_token_expires_in: tokenPair.refreshTokenExpiresInSeconds,
        token_type: 'Bearer',
      });
    },
  );
}
