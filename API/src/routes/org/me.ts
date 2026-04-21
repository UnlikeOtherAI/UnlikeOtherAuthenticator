import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireDomainHashAuthForDomainQuery } from '../../middleware/domain-hash-auth.js';
import { requireOrgFeaturesEnabled } from '../../middleware/org-features.js';
import { verifyAccessToken } from '../../services/access-token.service.js';
import { getUserOrgContext } from '../../services/org-context.service.js';
import { AppError } from '../../utils/errors.js';
import { configVerifier } from '../../middleware/config-verifier.js';
import { assertVerifiedDomainMatchesQuery, normalizeDomain } from './domain-context.js';

const QuerySchema = z
  .object({
    domain: z.string().trim().min(1),
    config_url: z.string().trim().min(1),
  })
  .strict();

function parseBearerOrRawToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('bearer ')) return trimmed;

  const token = trimmed.slice('bearer '.length).trim();
  return token || null;
}

export function registerOrgMeRoute(app: FastifyInstance): void {
  app.get(
    '/org/me',
    {
      preHandler: [requireDomainHashAuthForDomainQuery, configVerifier, requireOrgFeaturesEnabled],
    },
    async (request, reply) => {
      const { domain } = QuerySchema.parse(request.query);
      const normalizedDomain = normalizeDomain(domain);
      assertVerifiedDomainMatchesQuery(request, normalizedDomain);

      const token = parseBearerOrRawToken(request.headers['x-uoa-access-token']);
      if (!token) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
      }

      const claims = await verifyAccessToken(token);
      if (normalizeDomain(claims.domain) !== normalizedDomain) {
        throw new AppError('FORBIDDEN', 403, 'ACCESS_TOKEN_DOMAIN_MISMATCH');
      }

      const config = request.config;
      if (!config) {
        throw new AppError('UNAUTHORIZED', 401, 'MISSING_CONFIG');
      }

      const org = await getUserOrgContext({
        userId: claims.userId,
        domain: normalizedDomain,
        config,
      });

      const response: { ok: true; org?: typeof org } = { ok: true };
      if (org) response.org = org;

      reply.status(200).send(response);
    },
  );
}
