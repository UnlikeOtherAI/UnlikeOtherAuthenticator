import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { validateRegistrationEmailLandingToken } from '../../services/auth-registration-email-link.service.js';
import { renderAuthEntrypointHtml } from '../../services/auth-ui.service.js';
import { issueAuthorizationCode, buildRedirectToUrl, selectRedirectUrl } from '../../services/token.service.js';
import { verifyEmailToken } from '../../services/auth-verify-email.service.js';
import { recordLoginLog } from '../../services/login-log.service.js';

const QuerySchema = z
  .object({
    token: z.string().min(1),
    redirect_url: z.string().min(1).optional(),
  })
  .passthrough();

export function registerAuthEmailRegistrationLinkRoute(app: FastifyInstance): void {
  app.get(
    '/auth/email/link',
    {
      preHandler: [configVerifier],
    },
    async (request, reply) => {
      const { token, redirect_url } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      let type: Awaited<ReturnType<typeof validateRegistrationEmailLandingToken>>;
      try {
        type = await validateRegistrationEmailLandingToken({
          token,
          config: request.config,
          configUrl: request.configUrl,
        });
      } catch {
        reply.status(400).send({ error: 'Request failed' });
        return;
      }

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

          const finalUrl = buildRedirectToUrl({ redirectUrl, code });
          if (finalUrl) {
            reply.redirect(finalUrl, 302);
            return;
          }
        } catch (err) {
          request.log.error({ err }, 'email link auto-consume failed');
        }

        reply.status(400).send({ error: 'Request failed' });
        return;
      }

      // VERIFY_EMAIL_SET_PASSWORD: render the Auth UI with the set-password view.
      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: buildAuthUrl(request.configUrl, redirect_url, token, type),
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
): string {
  const params = new URLSearchParams();
  params.set('config_url', configUrl);
  if (redirectUrl) params.set('redirect_url', redirectUrl);
  params.set('email_token', token);
  params.set('email_token_type', type);
  return `/auth?${params.toString()}`;
}
