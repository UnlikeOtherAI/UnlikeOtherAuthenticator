import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { MembershipStatus } from '@prisma/client';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { getAdminPrisma } from '../../../db/prisma.js';
import { writeOrgAuditLog } from '../../../services/org-audit-log.service.js';
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

function actor(request: { adminAccessTokenClaims?: { userId: string; email: string } }): { userId: string; email: string } {
  if (!request.adminAccessTokenClaims?.userId || !request.adminAccessTokenClaims.email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return request.adminAccessTokenClaims;
}

async function assertExactUoaAdministration(actorId: string, params: { orgId: string; teamId?: string }, scope: AutomaticMembershipScope): Promise<void> {
  if (scope === 'organisation') {
    const membership = await getAdminPrisma().orgMember.findUnique({ where: { orgId_userId: { orgId: params.orgId, userId: actorId } }, select: { role: true, status: true } });
    if (membership?.status === MembershipStatus.ACTIVE && (membership.role === 'owner' || membership.role === 'admin')) return;
  } else if (params.teamId) {
    const membership = await getAdminPrisma().teamMember.findFirst({ where: { teamId: params.teamId, userId: actorId, status: MembershipStatus.ACTIVE, teamRole: { in: ['owner', 'admin'] }, team: { orgId: params.orgId } }, select: { id: true } });
    if (membership) return;
  }
  throw new AppError('FORBIDDEN', 403, 'AUTOMATIC_MEMBERSHIP_SCOPE_ADMIN_REQUIRED');
}

async function call(
  request: { adminAccessTokenClaims?: { userId: string; email: string } },
  params: { orgId: string; teamId?: string },
  scope: AutomaticMembershipScope,
  action: AutomaticMembershipControlAction,
  payload?: Record<string, unknown>,
) {
  const adminActor = actor(request);
  await assertExactUoaAdministration(adminActor.userId, params, scope);
  const result = await controlNessieAutomaticMembership({
    uoaActorSub: adminActor.userId, externalOrgId: params.orgId, externalTeamId: params.teamId,
    scope, action, payload,
  });
  if (!['list', 'teams'].includes(action)) {
    await writeOrgAuditLog({
      orgId: params.orgId, action: 'org.updated', targetType: scope === 'team' ? 'team' : 'organisation',
      targetId: params.teamId ?? params.orgId, actor: { via: 'admin_superuser', userId: adminActor.userId, email: adminActor.email },
      metadata: { automatic_membership_action: action, external_team_id: params.teamId ?? null },
    });
  }
  return result;
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
