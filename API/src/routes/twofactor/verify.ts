import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { verifyTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import { verifyTwoFactorForLogin } from '../../services/twofactor-login.service.js';
import {
  buildRedirectToUrl,
  issueAuthorizationCode,
  selectRedirectUrl,
} from '../../services/token.service.js';
import { AppError } from '../../utils/errors.js';

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
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { twofa_token, code } = BodySchema.parse(request.body);

      const config = request.config;
      if (!config) throw new Error('missing request.config');
      if (!request.configUrl) throw new Error('missing request.configUrl');

      // If the client didn't enable 2FA, treat this as a generic auth failure.
      if (!config['2fa_enabled']) {
        throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
      }

      const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
        'SHARED_SECRET',
        'AUTH_SERVICE_IDENTIFIER',
      );

      const challenge = await verifyTwoFaChallenge({
        token: twofa_token,
        sharedSecret: SHARED_SECRET,
        audience: AUTH_SERVICE_IDENTIFIER,
      });

      // Bind the challenge token to this config URL and domain.
      if (challenge.configUrl !== request.configUrl) {
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

      await verifyTwoFactorForLogin({ userId: challenge.userId, code });

      const { code: authCode } = await issueAuthorizationCode({
        userId: challenge.userId,
        domain: config.domain,
        configUrl: request.configUrl,
        redirectUrl,
      });

      try {
        await recordLoginLog({
          userId: challenge.userId,
          domain: config.domain,
          authMethod: challenge.authMethod,
          ip: request.ip ?? null,
          userAgent:
            typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent']
              : null,
        });
      } catch (err) {
        request.log.error({ err }, 'failed to record login log');
      }

      reply.status(200).send({
        ok: true,
        code: authCode,
        redirect_to: buildRedirectToUrl({ redirectUrl, code: authCode }),
      });
    },
  );
}
