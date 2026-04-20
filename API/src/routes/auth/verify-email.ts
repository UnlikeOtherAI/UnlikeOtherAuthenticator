import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { AppError } from '../../utils/errors.js';
import {
  validateVerifyEmailToken,
  verifyEmailToken,
} from '../../services/auth-verify-email.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { parsePkceChallenge } from '../../utils/pkce.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const BodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    config_url: z.string().min(1),
    redirect_url: z.string().min(1).optional(),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.string().min(1).optional(),
    request_access: z.string().optional(),
  })
  .strict();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes registration email verification. For password-required mode, a password is
  // required; for passwordless mode, token consumption signs the user in directly.
  app.post(
    '/auth/verify-email',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, password } = BodySchema.parse(request.body);
      const { redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const pkce = parsePkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const tokenType = await validateVerifyEmailToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      if (tokenType === 'VERIFY_EMAIL_SET_PASSWORD' && !password) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_PASSWORD');
      }

      const { userId, type } = await verifyEmailToken({
        token,
        password,
        config: request.config,
        configUrl: request.configUrl,
      });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: request.config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });
      const finalResult = await finalizeAuthenticatedUser({
        userId,
        config: request.config,
        configUrl: request.configUrl,
        redirectUrl,
        rememberMe: request.config.session?.remember_me_default ?? true,
        requestAccess: parseRequestAccessFlag(request_access),
        codeChallenge: pkce?.codeChallenge,
        codeChallengeMethod: pkce?.codeChallengeMethod,
      });

      try {
        await recordLoginLog({
          userId,
          domain: request.config.domain,
          authMethod: type === 'VERIFY_EMAIL' ? 'verify_email' : 'verify_email_set_password',
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
        code: finalResult.status === 'granted' ? finalResult.code : undefined,
        redirect_to: finalResult.redirectTo,
        access_request_status: finalResult.status === 'requested' ? 'pending' : undefined,
      });
    },
  );
}
