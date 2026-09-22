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
import { resolveProductBrandName } from '../../services/product-name.service.js';
import { describeInvitation, describeInviteDestination } from '../../services/team-invite-copy.js';
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
        reply.status(400).type('text/html; charset=utf-8').send(renderInviteUnavailableHtml(null));
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
              body: describeInvitation({
                inviterName: invite.invitedByName,
                teamName: invite.teamName,
                organisationName: invite.organisationName,
                productName: resolveProductBrandName(request.config),
              }),
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
        reply.status(400).type('text/html; charset=utf-8').send(renderInviteUnavailableHtml(null));
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
              body:
                `You declined the invitation to join ${describeInviteDestination(invite.teamName, invite.organisationName)}. ` +
                'Changed your mind? Ask the person who invited you to send a new one.',
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
