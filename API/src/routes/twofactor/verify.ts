import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAuthServiceIdentifier, requireEnv } from '../../config/env.js';
import { asPrismaClient } from '../../db/tenant-context.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { setTenantContextFromRequest } from '../../plugins/tenant-context.plugin.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { finalizeAuthenticatedUser } from '../../services/access-request-flow.service.js';
import { verifyTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import { verifyTwoFactorForLogin } from '../../services/twofactor-login.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';
import { twoFactorVerifyRateLimiter } from '../auth/rate-limit-keys.js';

const BodySchema = z
  .object({
    twofa_token: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

export function registerTwoFactorVerifyRoute(app: FastifyInstance): void {
  app.post(
    '/2fa/verify',
    {
      preHandler: [twoFactorVerifyRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { twofa_token, code } = BodySchema.parse(request.body);

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      // If the client didn't enable 2FA, treat this as a generic auth failure.
      if (!config['2fa_enabled']) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

      const challenge = await verifyTwoFaChallenge({
        token: twofa_token,
        sharedSecret: SHARED_SECRET,
        audience: getAuthServiceIdentifier(),
      });

      // Bind the challenge token to this config URL and domain.
      if (challenge.configUrl !== configUrl) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }
      if (challenge.domain !== config.domain) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }

      // Re-validate redirect URL against current config (config can change between steps).
      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: challenge.redirectUrl,
      });

      // Post-auth: challenge token is the bridge from primary auth. Tenant context = verified
      // config domain + userId recovered from the challenge JWT.
      setTenantContextFromRequest(request, { orgId: null, userId: challenge.userId });
      const finalResult = await request.withTenantTx(async (tx) => {
        const prisma = asPrismaClient(tx);
        await verifyTwoFactorForLogin({ userId: challenge.userId, code }, { prisma });

        const decision = await finalizeAuthenticatedUser(
          {
            userId: challenge.userId,
            config,
            configUrl,
            redirectUrl,
            rememberMe: challenge.rememberMe,
            requestAccess: challenge.requestAccess,
            codeChallenge: challenge.codeChallenge,
            codeChallengeMethod: challenge.codeChallengeMethod,
          },
          { prisma },
        );

        try {
          await recordLoginLog(
            {
              userId: challenge.userId,
              domain: config.domain,
              authMethod: challenge.authMethod,
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

        return decision;
      });

      reply.status(200).send({
        ok: true,
        code: finalResult.status === 'granted' ? finalResult.code : undefined,
        redirect_to: finalResult.redirectTo,
        access_request_status: finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
