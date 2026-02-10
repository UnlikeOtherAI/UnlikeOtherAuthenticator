import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { loginWithEmailPassword } from '../../services/auth-login.service.js';
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

      const { userId } = await loginWithEmailPassword({ email, password, config });

      const redirectUrl = selectRedirectUrl({
        allowedRedirectUrls: config.redirect_urls,
        requestedRedirectUrl: redirect_url,
      });
      const { code } = await issueAuthorizationCode({
        userId,
        domain: config.domain,
        configUrl: request.configUrl,
        redirectUrl,
      });

      reply.status(200).send({
        ok: true,
        code,
        redirect_to: buildRedirectToUrl({ redirectUrl, code }),
      });
    },
  );
}
