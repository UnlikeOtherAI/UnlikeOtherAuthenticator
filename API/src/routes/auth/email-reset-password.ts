import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validatePasswordResetToken } from '../../services/auth-reset-password.service.js';
import { renderAuthEntrypointHtml } from '../../services/auth-ui.service.js';
import { AppError } from '../../utils/errors.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    token: z.string().min(1),
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

export function registerAuthEmailResetPasswordRoute(app: FastifyInstance): void {
  // Email link landing for password reset. Validates the token, then renders
  // the Auth UI with the set-password view so the user can choose a new password.
  app.get(
    '/auth/email/reset-password',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, redirect_url } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      await validatePasswordResetToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      // Token is valid — render the Auth UI with the token context.
      const params = new URLSearchParams();
      params.set('config_url', request.configUrl);
      if (redirect_url) params.set('redirect_url', redirect_url);
      params.set('email_token', token);
      params.set('email_token_type', 'PASSWORD_RESET');

      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: `/auth?${params.toString()}`,
      });
      reply.type('text/html; charset=utf-8').status(200).send(html);
    },
  );
}
