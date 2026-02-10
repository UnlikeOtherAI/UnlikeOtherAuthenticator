import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { verifyEmailAndSetPassword } from '../../services/auth-verify-email.service.js';
import {
  buildRedirectToUrl,
  issueAuthorizationCode,
  selectRedirectUrl,
} from '../../services/token.service.js';

const BodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

const QuerySchema = z
  .object({
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

export function registerAuthVerifyEmailRoute(app: FastifyInstance): void {
  // Completes the "verify email + set password" flow for new users.
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

      const { userId } = await verifyEmailAndSetPassword({
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

      reply.status(200).send({
        ok: true,
        code,
        redirect_to: buildRedirectToUrl({ redirectUrl, code }),
      });
    },
  );
}
