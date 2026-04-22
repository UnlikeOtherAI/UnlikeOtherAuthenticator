import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { requireDomainHashAuth } from '../../middleware/domain-hash-auth.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
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

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      // Token exchange runs under domain-only tenant context. The service looks up the
      // authorization code / refresh token row inside the tx; users policy allows that
      // lookup with app.domain alone, and downstream token writes stay scoped the same.
      setTenantContextFromRequest(request, { orgId: null, userId: null });

      const tokenPair = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);
        return body.grant_type === 'refresh_token'
          ? exchangeRefreshTokenForTokens(
              {
                refreshToken: body.refresh_token,
                config,
                configUrl,
                clientId: request.domainAuthClientId,
              },
              { prisma },
            )
          : exchangeAuthorizationCodeForTokens(
              {
                code: body.code,
                config,
                configUrl,
                redirectUrl: body.redirect_url,
                codeVerifier: body.code_verifier,
                clientId: request.domainAuthClientId,
              },
              { prisma },
            );
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
