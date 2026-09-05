import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import {
  declineTeamInviteByToken,
  getTeamInviteLandingData,
} from '../../services/team-invite.service.js';
import {
  renderInviteHtml,
  renderInviteUnavailableHtml,
} from '../../services/team-invite-page.service.js';
import { tokenConsumeRateLimiter } from './rate-limit-keys.js';

const QuerySchema = z
  .object({
    config_url: z.string().trim().min(1).max(2048),
    token: z.string().trim().min(1).max(4096),
    redirect_url: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

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
        const invite = await getTeamInviteLandingData(
          {
            token,
            config: request.config,
            configUrl: request.configUrl,
          },
          { prisma: request.adminDb },
        );

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
      } catch (err) {
        reply.status(400).type('text/html; charset=utf-8').send(renderInviteUnavailableHtml(err));
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
        const invite = await declineTeamInviteByToken(
          {
            token,
            config: request.config,
            configUrl: request.configUrl,
          },
          { prisma: request.adminDb },
        );

        reply
          .status(200)
          .type('text/html; charset=utf-8')
          .send(
            renderInviteHtml({
              title: 'Invitation declined',
              body: `${invite.inviteName ?? invite.email} declined the invitation to join ${invite.teamName} on ${invite.organisationName}.`,
            }),
          );
      } catch (err) {
        reply.status(400).type('text/html; charset=utf-8').send(renderInviteUnavailableHtml(err));
      }
    },
  );
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
