import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { listHandshakeErrorLogs } from '../../../services/handshake-error-log.service.js';
import {
  getAdminDashboard,
  getAdminDomain,
  getAdminDomains,
  getAdminLogs,
  getAdminOrganisation,
  getAdminOrganisations,
  getAdminSession,
  getAdminSettings,
  getAdminTeam,
  getAdminTeams,
  getAdminUser,
  getAdminUsers,
  searchAdmin,
} from '../../../services/internal-admin.service.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const IdParamsSchema = z.object({ orgId: z.string().trim().min(1) });
const TeamParamsSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});
const UserParamsSchema = z.object({ userId: z.string().trim().min(1) });
const DomainParamsSchema = z.object({ domain: z.string().trim().min(3).transform(normalizeDomain) });
const LimitQuerySchema = z.object({ limit: z.coerce.number().int().positive().optional() }).strict();
const SearchQuerySchema = z.object({ q: z.string().trim().default('') }).strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = { type: 'array', items: objectSchema } as const;
const nullableObjectSchema = { anyOf: [objectSchema, { type: 'null' }] } as const;
const sessionSchema = {
  type: 'object',
  required: ['ok', 'adminUser'],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    adminUser: objectSchema,
  },
} as const;
const dashboardSchema = {
  type: 'object',
  required: ['stats', 'domains', 'organisations', 'users', 'logs', 'handshakeErrors', 'bans', 'apps'],
  additionalProperties: false,
  properties: {
    stats: objectSchema,
    domains: arraySchema,
    organisations: arraySchema,
    users: arraySchema,
    logs: arraySchema,
    handshakeErrors: arraySchema,
    bans: objectSchema,
    apps: arraySchema,
  },
} as const;
const settingsSchema = {
  type: 'object',
  required: ['bans', 'apps'],
  additionalProperties: false,
  properties: {
    bans: objectSchema,
    apps: arraySchema,
  },
} as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

export function registerInternalAdminReadRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/session', adminRoute(sessionSchema), async (request) => {
    if (!request.adminAccessTokenClaims) {
      throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
    }
    return getAdminSession(request.adminAccessTokenClaims);
  });

  app.get('/internal/admin/dashboard', adminRoute(dashboardSchema), async () => getAdminDashboard());
  app.get('/internal/admin/domains', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return getAdminDomains(limit);
  });
  app.get('/internal/admin/organisations', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return getAdminOrganisations(limit);
  });
  app.get('/internal/admin/teams', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return getAdminTeams(limit);
  });
  app.get('/internal/admin/users', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return getAdminUsers(limit);
  });
  app.get('/internal/admin/settings', adminRoute(settingsSchema), async () => getAdminSettings());

  app.get('/internal/admin/logs', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return getAdminLogs(limit);
  });

  app.get('/internal/admin/handshake-errors', adminRoute(arraySchema), async (request) => {
    const { limit } = LimitQuerySchema.parse(request.query);
    return listHandshakeErrorLogs({ limit });
  });

  app.get('/internal/admin/search', adminRoute(arraySchema), async (request) => {
    const { q } = SearchQuerySchema.parse(request.query);
    return searchAdmin(q);
  });

  app.get('/internal/admin/organisations/:orgId', adminRoute(nullableObjectSchema), async (request) => {
    const { orgId } = IdParamsSchema.parse(request.params);
    return getAdminOrganisation(orgId);
  });

  app.get(
    '/internal/admin/organisations/:orgId/teams/:teamId',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { orgId, teamId } = TeamParamsSchema.parse(request.params);
      return getAdminTeam(orgId, teamId);
    },
  );

  app.get('/internal/admin/users/:userId', adminRoute(nullableObjectSchema), async (request) => {
    const { userId } = UserParamsSchema.parse(request.params);
    return getAdminUser(userId);
  });

  app.get('/internal/admin/domains/:domain', adminRoute(nullableObjectSchema), async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    return getAdminDomain(domain);
  });
}
