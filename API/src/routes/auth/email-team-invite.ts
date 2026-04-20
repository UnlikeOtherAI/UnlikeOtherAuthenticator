import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import {
  declineTeamInviteByToken,
  getTeamInviteLandingData,
} from '../../services/team-invite.service.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().trim().min(1),
    token: z.string().trim().min(1),
    redirect_url: z.string().trim().min(1).optional(),
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

function buildAcceptUrl(params: {
  token: string;
  configUrl: string;
  redirectUrl?: string;
}): string {
  const query = new URLSearchParams();
  query.set('token', params.token);
  query.set('config_url', params.configUrl);
  if (params.redirectUrl) {
    query.set('redirect_url', params.redirectUrl);
  }
  return `/auth/email/link?${query.toString()}`;
}

function buildDeclineUrl(params: { token: string; configUrl: string }): string {
  const query = new URLSearchParams();
  query.set('token', params.token);
  query.set('config_url', params.configUrl);
  return `/auth/email/team-invite/decline?${query.toString()}`;
}

function renderInviteHtml(params: {
  title: string;
  body: string;
  acceptUrl?: string;
  declineUrl?: string;
}): string {
  const primaryButton = params.acceptUrl
    ? `<a href="${escapeHtml(params.acceptUrl)}" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;">Accept invitation</a>`
    : '';
  const declineButton = params.declineUrl
    ? `<a href="${escapeHtml(params.declineUrl)}" style="display:inline-block;padding:12px 16px;border-radius:12px;border:1px solid #d1d5db;color:#111827;text-decoration:none;font-weight:600;">Decline invitation</a>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(params.title)}</title>
  </head>
  <body style="margin:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:48px auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;">
        <h1 style="margin:0 0 16px 0;font-size:28px;line-height:1.2;">${escapeHtml(params.title)}</h1>
        <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;">${escapeHtml(params.body)}</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${primaryButton}${declineButton}</div>
      </div>
    </div>
  </body>
</html>`;
}

export function registerAuthEmailTeamInviteRoute(app: FastifyInstance): void {
  app.get(
    '/auth/email/team-invite',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token, redirect_url } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation unavailable',
              body: 'This invitation is no longer available.',
            }),
          );
        return;
      }

      try {
        const invite = await getTeamInviteLandingData({
          token,
          config: request.config,
          configUrl: request.configUrl,
        });

        reply
          .status(200)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: `Join ${invite.teamName}`,
              body: `${invite.inviteName ?? invite.email} has been invited to join ${invite.teamName} on ${invite.organisationName}.`,
              acceptUrl: buildAcceptUrl({
                token,
                configUrl: request.configUrl,
                redirectUrl: redirect_url,
              }),
              declineUrl: buildDeclineUrl({
                token,
                configUrl: request.configUrl,
              }),
            }),
          );
      } catch {
        reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation unavailable',
              body: 'This invitation is no longer available.',
            }),
          );
      }
    },
  );

  app.get(
    '/auth/email/team-invite/decline',
    {
      preHandler: [tokenConsumeRateLimiter, configVerifier],
    },
    async (request, reply) => {
      const { token } = QuerySchema.parse(request.query);

      if (!request.config || !request.configUrl) {
        reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation unavailable',
              body: 'This invitation is no longer available.',
            }),
          );
        return;
      }

      try {
        const invite = await declineTeamInviteByToken({
          token,
          config: request.config,
          configUrl: request.configUrl,
        });

        reply
          .status(200)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation declined',
              body: `${invite.inviteName ?? invite.email} declined the invitation to join ${invite.teamName} on ${invite.organisationName}.`,
            }),
          );
      } catch {
        reply
          .status(400)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation unavailable',
              body: 'This invitation is no longer available.',
            }),
          );
      }
    },
  );
}
