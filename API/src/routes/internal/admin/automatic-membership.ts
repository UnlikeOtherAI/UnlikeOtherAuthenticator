import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  controlNessieAutomaticMembership,
  type AutomaticMembershipControlAction,
  type AutomaticMembershipScope,
} from '../../../services/nessie-automatic-membership-control.service.js';
import { AppError } from '../../../utils/errors.js';

const orgParams = z.object({ orgId: z.string().trim().min(1) });
const teamParams = orgParams.extend({ teamId: z.string().trim().min(1) });
const actionSchema = z.enum(['create', 'update', 'verify', 'rotate', 'activate', 'suspend', 'revoke', 'release']);
const ruleIdPayload = z.object({ rule_id: z.string().trim().min(1).max(128) }).strict();
const createPayload = z.object({
  domain: z.string().trim().min(1).max(253),
  notification_email: z.string().trim().email().nullable().optional(),
  team_ids: z.array(z.string().trim().min(1)).max(100).optional(),
}).strict();
const updatePayload = ruleIdPayload.extend({
  notification_email: z.string().trim().email().nullable().optional(),
  team_ids: z.array(z.string().trim().min(1)).max(100).optional(),
}).strict();
const mutationSchema = z.object({ action: actionSchema, payload: z.record(z.unknown()).default({}) }).strict();
const objectSchema = { type: 'object', additionalProperties: true } as const;

function adminRoute(): RouteShorthandOptions {
  return { preHandler: [requireAdminSuperuser], schema: { response: { 200: objectSchema } } };
}

function actor(request: { adminAccessTokenClaims?: { userId: string } }): string {
  if (!request.adminAccessTokenClaims?.userId) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return request.adminAccessTokenClaims.userId;
}

function call(
  request: { adminAccessTokenClaims?: { userId: string } },
  params: { orgId: string; teamId?: string },
  scope: AutomaticMembershipScope,
  action: AutomaticMembershipControlAction,
  payload?: Record<string, unknown>,
) {
  return controlNessieAutomaticMembership({
    uoaActorSub: actor(request), externalOrgId: params.orgId, externalTeamId: params.teamId,
    scope, action, payload,
  });
}

function parseMutation(body: unknown, scope: AutomaticMembershipScope): {
  action: AutomaticMembershipControlAction; payload: Record<string, unknown>;
} {
  const parsed = mutationSchema.parse(body);
  if (parsed.action === 'create') {
    const payload = createPayload.parse(parsed.payload);
    if (scope === 'organisation' && (!payload.team_ids || payload.team_ids.length === 0)) {
      throw new AppError('BAD_REQUEST', 400, 'AUTOMATIC_MEMBERSHIP_TEAM_MAPPING_REQUIRED');
    }
    if (scope === 'team' && payload.team_ids) {
      throw new AppError('BAD_REQUEST', 400, 'AUTOMATIC_MEMBERSHIP_TEAM_MAPPING_NOT_ALLOWED');
    }
    return { action: parsed.action, payload };
  }
  if (parsed.action === 'update') {
    const payload = updatePayload.parse(parsed.payload);
    if (scope === 'team' && payload.team_ids) {
      throw new AppError('BAD_REQUEST', 400, 'AUTOMATIC_MEMBERSHIP_TEAM_MAPPING_NOT_ALLOWED');
    }
    return { action: parsed.action, payload };
  }
  return { action: parsed.action, payload: ruleIdPayload.parse(parsed.payload) };
}

/** UOA-superuser-only browser facade for Nessie's server-side rule engine. */
export function registerInternalAdminAutomaticMembershipRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/organisations/:orgId/automatic-membership', adminRoute(), async (request) => {
    const params = orgParams.parse(request.params);
    return call(request, params, 'organisation', 'list');
  });
  app.get('/internal/admin/organisations/:orgId/automatic-membership/teams', adminRoute(), async (request) => {
    const params = orgParams.parse(request.params);
    return call(request, params, 'organisation', 'teams');
  });
  app.post('/internal/admin/organisations/:orgId/automatic-membership', adminRoute(), async (request) => {
    const params = orgParams.parse(request.params);
    const body = parseMutation(request.body, 'organisation');
    return call(request, params, 'organisation', body.action, body.payload);
  });
  app.get('/internal/admin/organisations/:orgId/teams/:teamId/automatic-membership', adminRoute(), async (request) => {
    const params = teamParams.parse(request.params);
    return call(request, params, 'team', 'list');
  });
  app.post('/internal/admin/organisations/:orgId/teams/:teamId/automatic-membership', adminRoute(), async (request) => {
    const params = teamParams.parse(request.params);
    const body = parseMutation(request.body, 'team');
    return call(request, params, 'team', body.action, body.payload);
  });
}
