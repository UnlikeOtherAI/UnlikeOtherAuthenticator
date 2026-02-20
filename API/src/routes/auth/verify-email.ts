import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import {
  validateVerifyEmailToken,
  verifyEmailToken,
} from '../../services/auth-verify-email.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import {
  buildRedirectToUrl,
  issueAuthorizationCode,
  selectRedirectUrl,
} from '../../services/token.service.js';

const BodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .strict();

const QuerySchema = z
  .object({
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes registration email verification. For password-required mode, a password is
  // required; for passwordless mode, token consumption signs the user in directly.
  app.post(
    '/auth/verify-email',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token, password } = BodySchema.parse(request.body);
      const { redirect_url } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      const tokenType = await validateVerifyEmailToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      if (tokenType === 'VERIFY_EMAIL_SET_PASSWORD' && !password) {
        reply.status(400).send({ error: 'Request failed' });
        return;
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
      const { code } = await issueAuthorizationCode({
        userId,
        domain: request.config.domain,
        configUrl: request.configUrl,
        redirectUrl,
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
        code,
        redirect_to: buildRedirectToUrl({ redirectUrl, code }),
      });
    },
  );
}
