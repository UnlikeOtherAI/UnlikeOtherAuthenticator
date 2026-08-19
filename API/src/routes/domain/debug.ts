import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireSuperuserAccessTokenForDomainQuery } from '../../middleware/superuser-access-token.js';
import { avatarImageBaseUrl, domainAvatarImageUrl } from '../../utils/avatar-url.js';
import { normalizeDomain } from '../../utils/domain.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
  })
  .strict();

/**
 * Brief 12.4: domain debug endpoint, superuser only.
 *
 * Requires:
 * - Authorization: Bearer <domain client hash>
 * - x-uoa-access-token: Bearer <access token JWT for a SUPERUSER on that domain>
 */
export function registerDomainDebugRoute(app: FastifyInstance): void {
  app.get(
    '/domain/debug',
    {
      preHandler: [requireDomainHashAuthForDomainQuery, requireSuperuserAccessTokenForDomainQuery],
    },
    async (request, reply) => {
      const { domain } = QuerySchema.parse(request.query);
      const normalizedDomain = normalizeDomain(domain);

      const claims = request.accessTokenClaims;
      if (!claims) {
        throw new Error('missing request.accessTokenClaims');
      }
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      reply.status(200).send({
        ok: true,
        domain: normalizedDomain,
        // The client-domain row id, not the bearer — the middleware's own declaration says the
        // hash must never be returned in a response (domain-hash-auth.ts).
        client_id: request.domainAuthClientDomainId,
        superuser: {
          user_id: claims.userId,
          email: claims.email,
          // Docs/Auth/avatars.md §9 — same domain-hash credential fetches it.
          avatar_image_url: domainAvatarImageUrl({
            baseUrl: avatarImageBaseUrl(),
            domain: normalizedDomain,
            userId: claims.userId,
          }),
        },
      });
    },
  );
}
