import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validateRegistrationEmailLandingToken } from '../../services/auth-registration-email-link.service.js';
import {
  finalizeAuthenticatedUser,
  parseRequestAccessFlag,
} from '../../services/access-request-flow.service.js';
import { renderAuthEntrypointHtml } from '../../services/auth-ui.service.js';
import { selectRedirectUrl } from '../../services/token.service.js';
import { verifyEmailToken } from '../../services/auth-verify-email.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';
import { AppError } from '../../utils/errors.js';
import { parseRequiredPkceChallenge } from '../../utils/pkce.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().min(1),
    token: z.string().min(1),
    redirect_url: z.string().min(1).optional(),
    code_challenge: z.string().min(1).optional(),
    code_challenge_method: z.string().min(1).optional(),
    request_access: z.string().optional(),
  })
  .strict();

function redirectNoStore(reply: FastifyReply, url: string): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.redirect(url, 302);
}

export function registerAuthEmailRegistrationLinkRoute(app: FastifyInstance): void {
  app.get(
    '/auth/email/link',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, redirect_url, code_challenge, code_challenge_method, request_access } =
        QuerySchema.parse(request.query);
      const pkce = parseRequiredPkceChallenge({
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const type = await validateRegistrationEmailLandingToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      // LOGIN_LINK and VERIFY_EMAIL: auto-consume the token and redirect immediately.
      // No password needed — the user is signed in by clicking the link.
      if (type === 'LOGIN_LINK' || type === 'VERIFY_EMAIL') {
        try {
          const { userId } = await verifyEmailToken({
            token,
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
              authMethod: type === 'VERIFY_EMAIL' ? 'verify_email' : 'login_link',
              ip: request.ip ?? null,
              userAgent:
                typeof request.headers['user-agent'] === 'string'
                  ? request.headers['user-agent']
                  : null,
            });
          } catch (err) {
            request.log.error({ err }, 'failed to record login log');
          }

          const finalUrl = finalResult.redirectTo;
          if (finalUrl) {
            redirectNoStore(reply, finalUrl);
            return;
          }
        } catch (err) {
          request.log.error({ err }, 'email link auto-consume failed');
          throw err;
        }

        throw new AppError('INTERNAL', 500, 'AUTH_REDIRECT_MISSING');
      }

      // VERIFY_EMAIL_SET_PASSWORD: render the Auth UI with the set-password view.
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: buildAuthUrl(
          request.configUrl,
          redirect_url,
          token,
          type,
          parseRequestAccessFlag(request_access),
          pkce,
        ),
      });
      reply.type('text/html; charset=utf-8').status(200).send(html);
    },
  );
}

function buildAuthUrl(
  configUrl: string,
  redirectUrl: string | undefined,
  token: string,
  type: string,
  requestAccess: boolean,
  pkce: ReturnType<typeof parsePkceChallenge>,
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  if (pkce) {
    params.set('code_challenge', pkce.codeChallenge);
    params.set('code_challenge_method', pkce.codeChallengeMethod);
  }
  params.set('email_token', token);
  params.set('email_token_type', type);
  if (requestAccess) params.set('request_access', 'true');
  return `/auth?${params.toString()}`;
}
