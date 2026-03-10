import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { AppError } from '../../utils/errors.js';
import {
  exchangeAuthorizationCodeForTokens,
  exchangeRefreshTokenForTokens,
} from '../../services/token.service.js';

const AuthorizationCodeGrantSchema = z
  .object({
    grant_type: z.literal('authorization_code').optional(),
    code: z.string().min(1),
  })
  .strict();

const RefreshTokenGrantSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1),
  })
  .strict();

type TokenExchangeBody =
  | { grant_type?: 'authorization_code'; code: string }
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
      preHandler: [configVerifier, requireDomainHashAuth],
    },
    async (request, reply) => {
      const body = parseTokenExchangeBody(request.body);

      if (!request.config || !request.configUrl) {
        // configVerifier should always attach these; fail closed.
        reply.status(400).send({ error: 'Request failed' });
        return;
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
            });

      // Keep response OAuth-ish without being overly strict about fields.
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
