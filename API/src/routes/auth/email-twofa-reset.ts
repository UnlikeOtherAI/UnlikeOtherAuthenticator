import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { sendAuthHtml } from '../../services/auth-ui.service.js';
import { resetTwoFaWithToken } from '../../services/twofactor-reset.service.js';
import { AppError } from '../../utils/errors.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildConfirmAction(params: { token: string; configUrl: string }): string {
  const query = new URLSearchParams();
  query.set('token', params.token);
  query.set('config_url', params.configUrl);
  return `/auth/email/twofa-reset/confirm?${query.toString()}`;
}

function renderPage(params: { title: string; body: string; formAction?: string }): string {
  const form = params.formAction
    ? `<form method="post" action="${escapeHtml(params.formAction)}" style="margin-top:24px;">
        <button type="submit" style="border:0;border-radius:10px;background:#111827;color:#ffffff;padding:12px 16px;font:inherit;cursor:pointer;">Reset two-factor authentication</button>
      </form>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>${escapeHtml(params.title)}</title>
  </head>
  <body style="margin:0;background:#f6f7fb;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <section style="width:100%;max-width:520px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;box-sizing:border-box;">
        <h1 style="margin:0 0 12px 0;font-size:22px;line-height:30px;">${escapeHtml(params.title)}</h1>
        <p style="margin:0;color:#4b5563;font-size:15px;line-height:24px;">${escapeHtml(params.body)}</p>
        ${form}
      </section>
    </main>
  </body>
</html>`;
}

export function registerAuthEmailTwoFaResetRoute(app: FastifyInstance): void {
  // Email link landing endpoint. GET only shows a confirmation page; the token
  // is consumed by explicit POST so link scanners cannot disable 2FA.
  app.get(
    '/auth/email/twofa-reset',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      const html = renderPage({
        title: 'Reset two-factor authentication',
        body: 'Confirm that you want to disable two-factor authentication for this account. You can set it up again after signing in.',
        formAction: buildConfirmAction({ token, configUrl: request.configUrl }),
      });
      sendAuthHtml(reply, html);
    },
  );

  app.post(
    '/auth/email/twofa-reset/confirm',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');
      }

      await resetTwoFaWithToken({
        token,
        config: request.config,
        configUrl: request.configUrl,
      });

      const html = renderPage({
        title: 'Two-factor authentication reset',
        body: 'Two-factor authentication has been disabled. You can now sign in and set it up again.',
      });
      sendAuthHtml(reply, html);
    },
  );
}
