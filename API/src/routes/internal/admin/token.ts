import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAdminAuthDomain, getAuthServiceIdentifier, getEnv } from '../../../config/env.js';
import { getAdminPrisma } from '../../../db/prisma.js';
import { configVerifier } from '../../../middleware/config-verifier.js';
import { verifyAccessToken } from '../../../services/access-token.service.js';
import { exchangeAuthorizationCodeForTokens } from '../../../services/token.service.js';
import { AppError } from '../../../utils/errors.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { tokenExchangeRateLimiter } from '../../auth/rate-limit-keys.js';

const AdminTokenBodySchema = z
  .object({
    code: z.string().min(1),
    redirect_url: z.string().min(1),
    code_verifier: z.string().min(1).optional(),
  })
  .strict();

const adminTokenResponseSchema = {
  type: 'object',
  required: ['access_token', 'expires_in', 'token_type'],
  additionalProperties: false,
  properties: {
    access_token: { type: 'string' },
    expires_in: { type: 'number' },
    token_type: { type: 'string', const: 'Bearer' },
  },
} as const;

function assertAdminConfigDomain(domain: string): void {
  const env = getEnv();
  if (!env.ADMIN_ACCESS_TOKEN_SECRET) {
    throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  }

  const adminDomain = normalizeDomain(getAdminAuthDomain(env));
  if (normalizeDomain(domain) !== adminDomain) {
    throw new AppError('FORBIDDEN', 403, 'ADMIN_DOMAIN_MISMATCH');
  }
}

async function assertAdminAccessTokenIsSuperuser(accessToken: string): Promise<void> {
  const env = getEnv();
  if (!env.ADMIN_ACCESS_TOKEN_SECRET) {
    throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  }

  const claims = await verifyAccessToken(accessToken, {
    sharedSecret: env.ADMIN_ACCESS_TOKEN_SECRET,
    issuer: getAuthServiceIdentifier(env),
  });
  const adminDomain = normalizeDomain(getAdminAuthDomain(env));

  if (claims.role !== 'superuser') {
    throw new AppError('FORBIDDEN', 403, 'NOT_SUPERUSER');
  }

  if (normalizeDomain(claims.domain) !== adminDomain) {
    throw new AppError('FORBIDDEN', 403, 'ADMIN_DOMAIN_MISMATCH');
  }

  if (env.DATABASE_URL) {
    const adminRole = await getAdminPrisma().domainRole.findUnique({
      where: { domain_userId: { domain: adminDomain, userId: claims.userId } },
      select: { role: true },
    });
    if (adminRole?.role !== 'SUPERUSER') {
      throw new AppError('FORBIDDEN', 403, 'ADMIN_ROLE_NOT_GRANTED');
    }
  }
}

export function registerInternalAdminTokenRoute(app: FastifyInstance): void {
  app.post(
    '/internal/admin/token',
    {
      preHandler: [tokenExchangeRateLimiter, configVerifier],
      schema: { response: { 200: adminTokenResponseSchema } },
    },
    async (request, reply) => {
      const body = AdminTokenBodySchema.parse(request.body);
      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      assertAdminConfigDomain(request.config.domain);
      const tokenPair = await exchangeAuthorizationCodeForTokens({
        code: body.code,
        config: request.config,
        configUrl: request.configUrl,
        redirectUrl: body.redirect_url,
        codeVerifier: body.code_verifier,
      });
      await assertAdminAccessTokenIsSuperuser(tokenPair.accessToken);

      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.status(200).send({
        access_token: tokenPair.accessToken,
        expires_in: tokenPair.expiresInSeconds,
        token_type: 'Bearer',
      });
    },
  );
}
