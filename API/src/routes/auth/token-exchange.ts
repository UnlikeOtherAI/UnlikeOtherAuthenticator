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
import {
  exchangeConfidentialSubjectToken,
  JWT_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from '../../services/confidential-token-exchange.service.js';
import {
  confidentialTokenExchangeDomainRateLimiter,
  tokenExchangePreAuthRateLimiter,
} from './rate-limit-keys.js';

const AuthorizationCodeGrantSchema = z
  .object({
    grant_type: z.literal('authorization_code').optional(),
    code: z.string().min(1).max(256),
    redirect_url: z.string().min(1).max(2048),
    code_verifier: z.string().min(1).max(256).optional(),
  })
  .strict();

const RefreshTokenGrantSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(4096),
  })
  .strict();

const ConfidentialTokenExchangeGrantSchema = z
  .object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z
      .string()
      .min(1)
      .max(16 * 1024),
    subject_token_type: z.literal(JWT_SUBJECT_TOKEN_TYPE),
    product: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    resource: z.string().min(1).max(2048),
    scope: z.string().trim().min(1).max(256),
  })
  .strict();

type TokenExchangeBody =
  | {
      grant_type?: 'authorization_code';
      code: string;
      redirect_url: string;
      code_verifier?: string;
    }
  | { grant_type: 'refresh_token'; refresh_token: string }
  | z.infer<typeof ConfidentialTokenExchangeGrantSchema>;

function parseTokenExchangeBody(body: unknown): TokenExchangeBody {
  const confidentialGrant = ConfidentialTokenExchangeGrantSchema.safeParse(body);
  if (confidentialGrant.success) {
    return confidentialGrant.data;
  }

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
      preHandler: [
        tokenExchangePreAuthRateLimiter,
        configVerifier,
        requireDomainHashAuth,
        confidentialTokenExchangeDomainRateLimiter,
      ],
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

      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');

      if (body.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
        const configJwt = request.configJwt;
        if (!configJwt) {
          throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
        }
        const authenticatedClientDomainId = request.domainAuthClientDomainId;
        if (!authenticatedClientDomainId) {
          throw new AppError('UNAUTHORIZED', 401);
        }
        const exchanged = await exchangeConfidentialSubjectToken(
          {
            authenticatedClientDomainId,
            subjectToken: body.subject_token,
            product: body.product,
            resource: body.resource,
            scope: body.scope,
            config,
            configJwt,
          },
          { prisma: request.adminDb },
        );
        reply.status(200).send({
          access_token: exchanged.accessToken,
          issued_token_type: exchanged.issuedTokenType,
          token_type: 'Bearer',
          expires_in: exchanged.expiresInSeconds,
          scope: exchanged.scope,
        });
        return;
      }

      const tokenPair =
        body.grant_type === 'refresh_token'
          ? await exchangeRefreshTokenForTokens(
              {
                refreshToken: body.refresh_token,
                config,
                configUrl,
                clientId: request.domainAuthClientId,
              },
              { prisma: request.adminDb, adminPrisma: request.adminDb },
            )
          : await request.withTenantTx(async (tx) =>
              exchangeAuthorizationCodeForTokens(
              {
                code: body.code,
                config,
                configUrl,
                redirectUrl: body.redirect_url,
                codeVerifier: body.code_verifier,
                clientId: request.domainAuthClientId,
              },
                { prisma: asPrismaClient(tx), adminPrisma: request.adminDb },
              ),
            );

      // Keep response OAuth-ish without being overly strict about fields.
      const responseBody: Record<string, unknown> = {
        access_token: tokenPair.accessToken,
        expires_in: tokenPair.expiresInSeconds,
        refresh_token: tokenPair.refreshToken,
        refresh_token_expires_in: tokenPair.refreshTokenExpiresInSeconds,
        token_type: 'Bearer',
      };
      if (tokenPair.firstLogin) {
        responseBody.firstLogin = tokenPair.firstLogin;
      }
      reply.status(200).send(responseBody);
    },
  );
}
