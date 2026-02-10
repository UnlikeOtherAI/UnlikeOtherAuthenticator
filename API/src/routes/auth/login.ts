import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { signTwoFaChallenge } from '../../services/twofactor-challenge.service.js';
import {
  buildRedirectToUrl,
  issueAuthorizationCode,
  selectRedirectUrl,
} from '../../services/token.service.js';

const LoginBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  })
  .strict();

const LoginQuerySchema = z
  .object({
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

export function registerAuthLoginRoute(app: FastifyInstance): void {
  app.post(
    '/auth/login',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { email, password } = LoginBodySchema.parse(request.body);
      const { redirect_url } = LoginQuerySchema.parse(request.query);

      // configVerifier guarantees request.config is set on success.
      const config = request.config;
      if (!config) {
        // Defensive: should never happen; still keep the error generic via global handler.
        throw new Error('missing request.config');
      }
      if (!request.configUrl) {
        throw new Error('missing request.configUrl');
      }

      const { userId, twoFaEnabled } = await loginWithEmailPassword({ email, password, config });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });

      // Brief 13 / Phase 8.6 + 8.7: enforce 2FA verification during login when enabled via config.
      if (config['2fa_enabled'] && twoFaEnabled) {
        const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
          'SHARED_SECRET',
          'AUTH_SERVICE_IDENTIFIER',
        );

        const twofa_token = await signTwoFaChallenge({
          userId,
          domain: config.domain,
          configUrl: request.configUrl,
          redirectUrl,
          authMethod: 'email_password',
          sharedSecret: SHARED_SECRET,
          audience: AUTH_SERVICE_IDENTIFIER,
        });

        reply.status(200).send({ ok: true, twofa_required: true, twofa_token });
        return;
      }

      const { code } = await issueAuthorizationCode({
        userId,
        domain: config.domain,
        configUrl: request.configUrl,
        redirectUrl,
      });

      try {
        await recordLoginLog({
          userId,
          email,
          domain: config.domain,
          authMethod: 'email_password',
          ip: request.ip ?? null,
          userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
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
