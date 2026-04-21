import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireSuperuserAccessTokenForDomainQuery } from '../../middleware/superuser-access-token.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
  })
  .strict();

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

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
      reply.status(200).send({
        ok: true,
        domain: normalizedDomain,
        client_id: request.domainAuthClientId,
        superuser: {
          user_id: claims.userId,
          email: claims.email,
        },
      });
    },
  );
}
