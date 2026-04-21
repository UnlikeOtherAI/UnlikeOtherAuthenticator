import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getEnv } from '../../../config/env.js';
import { configVerifier } from '../../../middleware/config-verifier.js';
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

  const adminDomain = normalizeDomain(env.ADMIN_AUTH_DOMAIN ?? env.AUTH_SERVICE_IDENTIFIER);
  if (normalizeDomain(domain) !== adminDomain) {
    throw new AppError('FORBIDDEN', 403, 'ADMIN_DOMAIN_MISMATCH');
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
