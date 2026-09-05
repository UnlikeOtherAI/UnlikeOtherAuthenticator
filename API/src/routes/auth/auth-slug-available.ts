import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LOGIN_SESSION_AUDIENCE } from '../../config/constants.js';
import { requireEnv } from '../../config/env.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { verifyLoginSession } from '../../services/login-session.service.js';
import {
  checkOrgSlugAvailability,
  checkTeamSlugAvailability,
} from '../../services/team-hostname.service.js';
import { AppError } from '../../utils/errors.js';

/**
 * `POST /auth/slug-available` — the address field's availability check, for the
 * hosted chooser.
 *
 * A separate route from `/domain/slug-available` because the chooser renders in
 * a popup that holds no domain-hash bearer; the only credential it has is the
 * short-lived login capability it is already using to create a team. That
 * capability is *verified* here and never consumed — this is a read the field
 * makes repeatedly while somebody types, and consuming the token would end
 * their session on the first keystroke.
 *
 * Nothing is revealed that the chooser does not already hold: an `org_id` must
 * be one the server itself listed in `creatable_orgs`, and the answer is a
 * yes/no about a label inside it.
 */

const BodySchema = z
  .object({
    login_token: z.string().min(1).max(4096),
    slug: z.string().trim().min(1).max(63),
    // Present for a team address, absent for a new organisation's own address.
    org_id: z.string().min(1).max(64).optional(),
  })
  .strict();

const QuerySchema = z.object({ config_url: z.string().min(1).max(2048) }).strict();

// Typing an address is bursty by nature, so the budget is generous but bounded:
// the field debounces to roughly one call per pause, not one per character.
const slugAvailabilityRateLimiter = createRateLimiter({
  limit: 120,
  windowMs: 60 * 1000,
  keyBuilder: (request: FastifyRequest) => `auth-slug-available:ip:${request.ip || 'unknown'}`,
});

export function registerAuthSlugAvailableRoute(app: FastifyInstance): void {
  app.post(
    '/auth/slug-available',
    { preHandler: [slugAvailabilityRateLimiter, configVerifier] },
    async (request, reply) => {
      const { login_token, slug, org_id } = BodySchema.parse(request.body);
      QuerySchema.parse(request.query);

      const config = request.config;
      const configUrl = request.configUrl;
      if (!config || !configUrl) throw new AppError('BAD_REQUEST', 400, 'MISSING_CONFIG');

      const { SHARED_SECRET } = requireEnv('SHARED_SECRET');
      // Verified, deliberately not consumed.
      await verifyLoginSession({
        token: login_token,
        config,
        configUrl,
        sharedSecret: SHARED_SECRET,
        audience: LOGIN_SESSION_AUDIENCE,
      });

      const reservedLabels = config.hostnames?.reserved_labels;

      const result = org_id
        ? await checkTeamSlugAvailability({ orgId: org_id, slug, reservedLabels })
        : await checkOrgSlugAvailability({ domain: config.domain, slug, reservedLabels });

      reply.status(200).send({ ok: true, ...result });
    },
  );
}
