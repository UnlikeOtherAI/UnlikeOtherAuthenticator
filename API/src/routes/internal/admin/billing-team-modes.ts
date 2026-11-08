import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { readTeamBillingMode, setTeamBillingMode } from '../../../services/billing-team-mode.service.js';
import { readOrganisationBillingMode,setOrganisationBillingMode } from '../../../services/billing-organisation-mode.service.js';

const Params = z.object({ orgId: z.string().min(1).max(256), teamId: z.string().min(1).max(256) }).strict();
const Body = z.object({ mode: z.enum(['live', 'sandbox']),
  expected_revision: z.number().int().nonnegative() }).strict();
const path = '/internal/admin/billing/organisations/:orgId/teams/:teamId/mode';

export function registerInternalAdminBillingTeamModeRoutes(app: FastifyInstance): void {
  const organisationPath='/internal/admin/billing/organisations/:orgId/mode';
  const orgParams=Params.pick({orgId:true}).strict();
  app.get(organisationPath,{preHandler:[requireAdminSuperuser]},async(request,reply)=>{
    const {orgId}=orgParams.parse(request.params);reply.header('Cache-Control','private, no-store');
    return readOrganisationBillingMode(orgId);
  });
  app.put(organisationPath,{preHandler:[requireAdminSuperuser]},async(request,reply)=>{
    const {orgId}=orgParams.parse(request.params);const body=Body.parse(request.body);
    const claims=request.adminAccessTokenClaims;
    const result=await setOrganisationBillingMode({organisationId:orgId,mode:body.mode,expectedRevision:body.expected_revision,
      actor:{userId:claims?.userId,email:claims?.email??'',tokenVersion:claims?.tokenVersion,domain:claims?.domain}});
    return reply.header('Cache-Control','private, no-store').send(result);
  });
  app.get(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { orgId, teamId } = Params.parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    return readTeamBillingMode({ organisationId: orgId, teamId });
  });
  app.put(path, { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { orgId, teamId } = Params.parse(request.params);
    const body = Body.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    const result = await setTeamBillingMode({ organisationId: orgId, teamId, mode: body.mode,
      expectedRevision: body.expected_revision, actor: { userId: claims?.userId,
        email: claims?.email ?? '', tokenVersion: claims?.tokenVersion, domain: claims?.domain } });
    reply.header('Cache-Control', 'private, no-store');
    return result;
  });
}
