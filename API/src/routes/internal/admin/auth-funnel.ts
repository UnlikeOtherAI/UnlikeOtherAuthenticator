import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { getAuthFunnelSummary } from '../../../services/auth-funnel.service.js';
import { normalizeDomain } from '../../../utils/domain.js';

const QuerySchema = z
  .object({
    from: z.string().trim().optional(),
    to: z.string().trim().optional(),
    domain: z.string().trim().min(3).transform(normalizeDomain).optional(),
  })
  .strict();

const countProperties = {
  step: { type: 'string' },
  outcome: { type: 'string' },
  count: { type: 'integer' },
} as const;

const countSchema = {
  type: 'object',
  required: ['step', 'outcome', 'count'],
  additionalProperties: false,
  properties: countProperties,
} as const;

const summarySchema = {
  type: 'object',
  required: ['from', 'to', 'domain', 'domains', 'totals', 'days'],
  additionalProperties: false,
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    domain: { type: ['string', 'null'] },
    domains: { type: 'array', items: { type: 'string' } },
    totals: { type: 'array', items: countSchema },
    days: {
      type: 'array',
      items: {
        type: 'object',
        required: ['day', 'step', 'outcome', 'count'],
        additionalProperties: false,
        properties: { day: { type: 'string' }, ...countProperties },
      },
    },
  },
} as const;

export function registerInternalAdminAuthFunnelRoutes(app: FastifyInstance): void {
  // Sign-up / sign-in funnel counts per UTC day and client domain (Docs/Auth/signup-funnel-metrics.md).
  app.get(
    '/internal/admin/auth-funnel',
    { preHandler: [requireAdminSuperuser], schema: { response: { 200: summarySchema } } },
    async (request) => {
      const query = QuerySchema.parse(request.query);
      return getAuthFunnelSummary(query, { prisma: request.adminDb });
    },
  );
}
