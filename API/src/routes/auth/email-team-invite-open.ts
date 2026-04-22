import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { trackTeamInviteOpen } from '../../services/team-invite.service.js';

const ParamsSchema = z.object({
  inviteId: z.string().trim().min(1),
});

const PIXEL_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export function registerAuthEmailTeamInviteOpenRoute(app: FastifyInstance): void {
  app.get('/auth/email/team-invite-open/:inviteId.gif', async (request, reply) => {
    const { inviteId } = ParamsSchema.parse(request.params);

    try {
      await trackTeamInviteOpen({ inviteId }, { prisma: request.adminDb });
    } catch (err) {
      request.log.error({ err }, 'team invite open tracking failed');
    }

    reply
      .header('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('pragma', 'no-cache')
      .type('image/gif')
      .send(Buffer.from(PIXEL_GIF_BASE64, 'base64'));
  });
}
