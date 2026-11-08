import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createRateLimiter } from '../../middleware/rate-limiter.js';
import {
  PUBLIC_TEAM_LOOKUP_MAX_IDS,
  lookupPublicTeams,
} from '../../services/public-team-lookup.service.js';

/**
 * `POST /public/teams/lookup` — unauthenticated batch read of team display fields by exact UOA
 * team id. See `lookupPublicTeams` for what is and is not returned.
 *
 * The caller is a product server (Nessie's API, batching all of one computer's teams), not an
 * end-user device, so the per-IP budget is sized for one server fronting a fleet of computers.
 * As on the public team-avatar route, the per-IP key moves with X-Forwarded-For when the edge
 * does not overwrite it, so a global bucket no request input can move bounds a header-rotating
 * flood. Both run on `onRequest`, before the body is parsed.
 */

const WINDOW_MS = 60 * 1000;
export const PUBLIC_TEAM_LOOKUP_IP_LIMIT_PER_MINUTE = 1_200;
export const PUBLIC_TEAM_LOOKUP_GLOBAL_LIMIT_PER_MINUTE = 6_000;

const ipRateLimit = createRateLimiter({
  keyBuilder: (request: FastifyRequest) => `public:team-lookup:${request.ip ?? 'unknown'}`,
  limit: PUBLIC_TEAM_LOOKUP_IP_LIMIT_PER_MINUTE,
  windowMs: WINDOW_MS,
});
const globalRateLimit = createRateLimiter({
  keyBuilder: () => 'public:team-lookup:global',
  limit: PUBLIC_TEAM_LOOKUP_GLOBAL_LIMIT_PER_MINUTE,
  windowMs: WINDOW_MS,
});
async function publicTeamLookupRateLimit(request: FastifyRequest): Promise<void> {
  await ipRateLimit(request);
  await globalRateLimit(request);
}

const BodySchema = z
  .object({
    teamIds: z.array(z.string().min(1).max(64)).max(PUBLIC_TEAM_LOOKUP_MAX_IDS),
  })
  .strict();

export function registerPublicTeamLookupRoute(app: FastifyInstance): void {
  app.post(
    '/public/teams/lookup',
    // 50 ids of at most 64 characters fit in well under 8 KiB of JSON.
    { bodyLimit: 8 * 1024, onRequest: [publicTeamLookupRateLimit] },
    async (request, reply) => {
      const { teamIds } = BodySchema.parse(request.body);
      const teams = await lookupPublicTeams(request.adminDb, teamIds);
      reply.header('Cache-Control', 'no-store');
      return { teams };
    },
  );
}
