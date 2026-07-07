import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { assertTeamInviteLinkValidForLanding } from '../../services/team-invite-link.service.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const ParamsSchema = z.object({
  token: z.string().trim().min(1).max(4096),
});

const QuerySchema = z
  .object({
    config_url: z.string().trim().min(1).max(2048),
    redirect_url: z.string().trim().min(1).max(2048).optional(),
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

function renderInvalidLinkHtml(): string {
  const title = 'Invite link unavailable';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;background:#f6f7fb;color:#111827;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <main style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <section style="width:100%;max-width:520px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;box-sizing:border-box;">
        <h1 style="margin:0 0 12px 0;font-size:22px;line-height:30px;">${escapeHtml(title)}</h1>
        <p style="margin:0;color:#4b5563;font-size:15px;line-height:24px;">This invite link is no longer available. Ask whoever shared it with you for a new one.</p>
      </section>
    </main>
  </body>
</html>`;
}

function buildBootstrapAuthUrl(params: {
  configUrl: string;
  token: string;
  redirectUrl?: string;
}): string {
  // Analogous to how email-registration-link.ts seeds `email_token`/`email_token_type` for the
  // Auth SPA to read off `window.__UOA_INITIAL_SEARCH__` — `invite_link_token` bootstraps the
  // normal email-verification entry (start -> verify-code / magic link); the client threads it
  // into `POST /auth/select-team` once identity is verified (Task 3). No membership is granted here.
  const query = new URLSearchParams();
  query.set('config_url', params.configUrl);
  query.set('invite_link_token', params.token);
  if (params.redirectUrl) {
    query.set('redirect_url', params.redirectUrl);
  }
  return `/auth?${query.toString()}`;
}

/**
 * Phase 5 Task 4 (design §4.7): shareable invite-link landing page. Public, IP-rate-limited, no
 * auth. Validates the token WITHOUT redeeming it (no `useCount` increment, no membership change) —
 * redemption only ever happens later on the verified-session `/auth/select-team` path. Every
 * invalid case (unknown token, revoked, expired, over-cap, or a HIDDEN team) renders the SAME
 * generic invalid-link page — no oracle on which condition failed.
 */
export function registerAuthTeamInviteLinkRoute(app: FastifyInstance): void {
  app.get(
    '/auth/team-invite-link/:token',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token } = ParamsSchema.parse(request.params);
      const { config_url: configUrl, redirect_url: redirectUrl } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        reply.status(400).type('text/html; charset=utf-8').send(renderInvalidLinkHtml());
        return;
      }

      try {
        await assertTeamInviteLinkValidForLanding(
          { token, domain: request.config.domain },
          { prisma: request.adminDb },
        );
      } catch {
        reply.status(400).type('text/html; charset=utf-8').send(renderInvalidLinkHtml());
        return;
      }

      const html = await renderAuthEntrypointHtml({
        config: request.config,
        configUrl: request.configUrl,
        requestUrl: buildBootstrapAuthUrl({ configUrl, token, redirectUrl }),
      });
      sendAuthHtml(reply, html);
    },
  );
}
