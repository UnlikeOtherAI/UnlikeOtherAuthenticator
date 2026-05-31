import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  updateAdminOrganisation,
  updateAdminTeam,
} from '../../../services/internal-admin.service.js';

const OrgParamsSchema = z.object({ orgId: z.string().trim().min(1) });
const TeamParamsSchema = z.object({
  orgId: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});
const AllowedEmailDomainsSchema = z
  .object({
    allowed_email_domains: z.array(z.string()).max(50),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const nullableObjectSchema = { anyOf: [objectSchema, { type: 'null' }] } as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

export function registerInternalAdminOrganisationRoutes(app: FastifyInstance): void {
  app.patch(
    '/internal/admin/organisations/:orgId',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { orgId } = OrgParamsSchema.parse(request.params);
      const body = AllowedEmailDomainsSchema.parse(request.body);
      return updateAdminOrganisation(orgId, { allowedEmailDomains: body.allowed_email_domains });
    },
  );

  app.patch(
    '/internal/admin/organisations/:orgId/teams/:teamId',
    adminRoute(nullableObjectSchema),
    async (request) => {
      const { orgId, teamId } = TeamParamsSchema.parse(request.params);
      const body = AllowedEmailDomainsSchema.parse(request.body);
      return updateAdminTeam(orgId, teamId, { allowedEmailDomains: body.allowed_email_domains });
    },
  );
}
