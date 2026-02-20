import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { configVerifier } from '../../middleware/config-verifier.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { lookupRegistrationDomainMapping } from '../../services/auth-domain-mapping.service.js';
import { AppError } from '../../utils/errors.js';

const DOMAIN_MAPPING_LOOKUP_RATE_LIMIT = 60;
const DOMAIN_MAPPING_LOOKUP_WINDOW_MS = 60 * 1000;

const QuerySchema = z
  .object({
    email_domain: z.string().trim().toLowerCase().min(1),
  })
  .passthrough();

function keyDomainMappingLookupRateLimit(request: FastifyRequest): string {
  return `auth:domain-mapping:${request.ip ?? 'unknown'}`;
}

export function registerAuthDomainMappingRoute(app: FastifyInstance): void {
  app.get(
    '/auth/domain-mapping',
    {
      preHandler: [
        createRateLimiter({
          keyBuilder: keyDomainMappingLookupRateLimit,
          limit: DOMAIN_MAPPING_LOOKUP_RATE_LIMIT,
          windowMs: DOMAIN_MAPPING_LOOKUP_WINDOW_MS,
        }),
        configVerifier,
      ],
    },
    async (request, reply) => {
      const { email_domain } = QuerySchema.parse(request.query);

      const config = request.config;
      if (!config) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const result = await lookupRegistrationDomainMapping({
        config,
        emailDomain: email_domain,
      });

      reply.status(200).send(result);
    },
  );
}
