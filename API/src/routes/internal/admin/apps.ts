import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { createAdminApp } from '../../../services/internal-admin.service.js';
import { normalizeDomain } from '../../../utils/domain.js';

const CreateAppSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    identifier: z.string().trim().min(1).max(160),
    platform: z.enum(['ios', 'android', 'web', 'macos', 'windows', 'linux', 'iot', 'tv', 'console', 'other']),
    domain: z.string().trim().min(3).transform(normalizeDomain),
    org_id: z.string().trim().min(1),
    offline_policy: z.enum(['allow', 'block', 'cached']).optional(),
    poll_interval_seconds: z.number().int().min(30).max(86400).optional(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

export function registerInternalAdminAppRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/apps', adminRoute(objectSchema), async (request) => {
    const body = CreateAppSchema.parse(request.body);
    return createAdminApp({
      name: body.name,
      identifier: body.identifier,
      platform: body.platform,
      domain: body.domain,
      orgId: body.org_id,
      offlinePolicy: body.offline_policy,
      pollIntervalSeconds: body.poll_interval_seconds,
    });
  });
}
