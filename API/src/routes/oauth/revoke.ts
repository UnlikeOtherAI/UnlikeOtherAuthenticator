import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { revokeNativeRefreshToken } from '../../services/oauth/native-refresh.service.js';
import { requireMcpOAuthPublicProfile } from './public-profile-guard.js';

// RFC 7009 token revocation for public clients of the MCP profile (brief §22.14). The
// public client_id binds the request to the family it issued; there is no secret. The
// answer is always 200 so revocation is never an oracle for whether a token existed,
// was already revoked or belongs to another client.
const RevokeBodySchema = z
  .object({
    token: z.string().min(1).max(4096),
    client_id: z.string().min(1).max(256),
    token_type_hint: z.string().max(64).optional(),
  })
  .strip();

export function registerOAuthRevokeRoute(app: FastifyInstance): void {
  const limiter = createRateLimiter({
    limit: 30,
    windowMs: 5 * 60 * 1000,
    keyBuilder: (request) => `oauth-revoke:ip:${request.ip || 'unknown'}`,
  });

  app.post(
    '/oauth/revoke',
    { preHandler: [requireMcpOAuthPublicProfile, limiter] },
    async (request, reply) => {
      const body = RevokeBodySchema.safeParse(request.body ?? {});
      if (body.success) {
        await revokeNativeRefreshToken(
          { token: body.data.token, clientId: body.data.client_id },
          request.adminDb,
        );
      }

      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.status(200).send({});
    },
  );
}
