import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validatePasswordResetToken } from '../../services/auth-reset-password.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import {
  appendPasswordResetContinuation,
  passwordResetContinuationQuery,
  readPasswordResetContinuation,
  type PasswordResetContinuation,
} from '../../services/password-reset-continuation.service.js';
import { AppError, isAppError } from '../../utils/errors.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().min(1).max(2048),
    token: z.string().min(1).max(4096),
    ...passwordResetContinuationQuery,
  })
  .strict();

function isEmailLinkTokenError(err: unknown): boolean {
  if (!isAppError(err)) return false;
  return [
    'INVALID_TOKEN',
    'INVALID_TOKEN_CONFIG_URL',
    'INVALID_TOKEN_TYPE',
    'TOKEN_ALREADY_USED',
    'TOKEN_EXPIRED',
  ].includes(err.message);
}

// The sign-in form shown after a reset (or for a stale link) posts to `/auth/login`, which
// requires the PKCE challenge, so the continuation rides every `/auth` URL built here.
function buildAuthUrl(
  configUrl: string,
  continuation: PasswordResetContinuation,
  emailToken?: string,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  appendPasswordResetContinuation(params, continuation);
  if (emailToken) {
    params.set('email_token', emailToken);
    params.set('email_token_type', 'PASSWORD_RESET');
  }
  return `/auth?${params.toString()}`;
}

export function registerAuthEmailResetPasswordRoute(app: FastifyInstance): void {
  // Email link landing for password reset. Validates the token, then renders
  // the Auth UI with the set-password view so the user can choose a new password.
  app.get(
    '/auth/email/reset-password',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      // Re-checked here rather than trusted from the email: a redirect outside
      // config.redirect_urls or a malformed challenge is dropped.
      const continuation = readPasswordResetContinuation(request.query, request.config);

      try {
        await validatePasswordResetToken(
          {
            token,
            config: request.config,
            configUrl: request.configUrl,
          },
          { prisma: request.adminDb },
        );
      } catch (err) {
        if (!isEmailLinkTokenError(err)) {
          throw err;
        }

        // Stale reset link (used/expired/invalid). A reset token is single-use and
        // expires after 30 min, so a page refresh on the landing URL re-validates a
        // now-unusable token. Render login instead of a hard error — the user can
        // request a fresh reset link from there. Mirrors the registration link route.
        request.log.info({ err }, 'password reset token could not be used; rendering login');
        const html = await renderAuthEntrypointHtml({
          config: request.config,
          configUrl: request.configUrl,
          requestUrl: buildAuthUrl(request.configUrl, continuation),
          cspNonce: reply.cspNonce?.script,
        });
        sendAuthHtml(reply, html);
        return;
      }

      // Token is valid — render the Auth UI with the token context.
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: buildAuthUrl(request.configUrl, continuation, token),
        cspNonce: reply.cspNonce?.script,
      });
      sendAuthHtml(reply, html);
    },
  );
}
