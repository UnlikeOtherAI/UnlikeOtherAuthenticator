import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createAdminBan,
  deleteAdminBan,
  listAdminBans,
} from '../../../services/internal-admin-bans.service.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const BanCreateSchema = z
  .object({
    type: z.enum(['email', 'pattern', 'ip', 'user']),
    value: z.string().trim().min(1).max(320),
    domain: z.string().trim().min(3).transform(normalizeDomain),
    org_id: z.string().trim().min(1).optional(),
    team_id: z.string().trim().min(1).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const BanParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const TYPE_BY_INPUT = {
  email: 'EMAIL',
  pattern: 'PATTERN',
  ip: 'IP',
  user: 'USER',
} as const;

const objectSchema = { type: 'object', additionalProperties: true } as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminBanRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/bans', adminRoute(objectSchema), async () => {
    return listAdminBans();
  });

  app.post('/internal/admin/bans', adminRoute(objectSchema), async (request) => {
    const body = BanCreateSchema.parse(request.body);
    const actorEmail = requireActorEmail(request);
    return createAdminBan({
      type: TYPE_BY_INPUT[body.type],
      value: body.value,
      domain: body.domain,
      orgId: body.org_id ?? null,
      teamId: body.team_id ?? null,
      reason: body.reason ?? null,
      createdByEmail: actorEmail,
    });
  });

  app.delete('/internal/admin/bans/:id', adminRoute(objectSchema), async (request) => {
    const { id } = BanParamsSchema.parse(request.params);
    requireActorEmail(request);
    return deleteAdminBan(id);
  });
}
