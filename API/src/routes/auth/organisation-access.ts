import { EnterprisePolicyPatch, updateEnterprisePolicy } from '../../services/org-sso-policy-management.service.js';
import { registerOrganisationAccessStart } from './organisation-access-start.js';
import { registerOrganisationAccessScim } from './organisation-access-scim.js';
import { registerOrganisationRecovery } from './organisation-recovery.js';
import { lockProductTeamPolicyShared } from '../../services/product-team-policy-lock.service.js';
import { lockAndWithdrawConnectionMemberships } from '../../services/membership-provenance.service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import type { Prisma } from '@prisma/client';
import { getAdminPrisma } from '../../db/prisma.js';
import { getPublicBaseUrl } from '../../config/env.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { exchangeManagementContinuation, managementSession, managementView,
  saveEnterpriseConnection } from '../../services/org-sso-management.service.js';
import { createEnterpriseDomain, verifyEnterpriseDomain, revokeEnterpriseDomain,
  reissueEnterpriseDomain } from '../../services/org-email-domain.service.js';
import { enterpriseReadiness } from '../../services/org-sso-policy.service.js';
import { revokeEnterpriseScope, lockEnterpriseOutbox } from '../../services/org-sso-revocation.service.js';
import { startEnterpriseTest } from '../../services/org-sso-flow.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { readAdminConfigJwt } from '../../services/admin-auth-config.service.js';
import { validateConfigFields } from '../../services/config.service.js';
import { AppError } from '../../utils/errors.js';

export const MANAGEMENT_COOKIE = 'uoa_org_access';
const base = '/auth/organisation-access';
const Connection = z.object({ preset: z.string().min(1).max(40), protocol: z.enum(['oidc', 'saml']),
  display_name: z.string().trim().min(1).max(100), configuration: z.record(z.unknown()),
  secret: z.string().min(1).max(20000).optional(), revision: z.number().int().positive().optional() }).strict();
const Params = z.object({ id: z.string().min(1).max(100) });
const csrf = (request: FastifyRequest): string | undefined => {
  const value = request.headers['x-uoa-csrf']; return typeof value === 'string' ? value : undefined;
};

export function registerOrganisationAccessRoutes(app: FastifyInstance): void {
  registerOrganisationAccessStart(app);
  const limiter = createRateLimiter({ keyBuilder: (request) => `enterprise-management:${request.ip}`, limit: 30, windowMs: 60000 });
  app.get(base, async (request, reply) => {
    const config = validateConfigFields(decodeJwt(readAdminConfigJwt()));
    const html = await renderAuthEntrypointHtml({ config: { ...config, language_config: ['en', 'cs', 'es'] },
      configUrl: `${getPublicBaseUrl()}/internal/admin/config`, requestUrl: request.raw.url,
      cspNonce: reply.cspNonce?.script });
    sendAuthHtml(reply, html);
  });
  app.post(`${base}/exchange`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const body = z.object({ continuation: z.string().min(32).max(256) }).strict().parse(request.body);
    const session = await exchangeManagementContinuation(body.continuation, request.cookies.uoa_management_intent);
    reply.setCookie(MANAGEMENT_COOKIE, session.browser, { path: base, httpOnly: true,
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', sameSite: 'strict', expires: session.expiresAt });
    const hydrated = await managementSession(session.browser);
    return reply.header('Cache-Control', 'no-store').send(await managementView(hydrated));
  });
  app.get(`${base}/sso`, { preHandler: limiter }, async (request, reply) => {
    const session = await managementSession(request.cookies[MANAGEMENT_COOKIE]);
    return reply.header('Cache-Control', 'no-store').send(await managementView(session));
  });
  const mutation = async <T>(request: FastifyRequest, run: (
    session: Awaited<ReturnType<typeof managementSession>>, tx: Prisma.TransactionClient,
  ) => Promise<T>) => getAdminPrisma().$transaction(async (tx) => {
    await lockEnterpriseOutbox(tx);
    await lockProductTeamPolicyShared(tx);
    const session = await managementSession(request.cookies[MANAGEMENT_COOKIE], csrf(request), true, tx);
    return run(session, tx);
  }, { timeout: 30000 });
  registerOrganisationAccessScim(app, mutation, limiter);
  registerOrganisationRecovery(app, mutation);
  app.post(`${base}/sso/connections`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const body = Connection.parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request,
      (session, tx) => saveEnterpriseConnection(session, body, undefined, tx)));
  });
  app.patch(`${base}/sso/connections/:id`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const body = Connection.parse(request.body); const { id } = Params.parse(request.params);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request,
      (session, tx) => saveEnterpriseConnection(session, body, id, tx)));
  });
  app.post(`${base}/sso/connections/:id/test`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
    const browser = request.cookies[MANAGEMENT_COOKIE] ?? '';
    const started = await mutation(request, (session, tx) => startEnterpriseTest(session, id, revision, browser, tx));
    reply.setCookie(`uoa_sso_${started.flow_id}`, browser, { path: '/sso', httpOnly: true,
      secure: true, sameSite: 'none', expires: new Date(started.expires_at) });
    return reply.header('Cache-Control', 'no-store').send(started);
  });
  app.post(`${base}/sso/connections/:id/state`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), status: z.enum(['active', 'disabled', 'suspended']) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request, async (session, tx) => {
      const row = await tx.orgSsoConnection.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
      if (!row || row.revision !== body.revision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
      if (body.status === 'active') {
        const readiness = await enterpriseReadiness(session.clientDomain, tx as ReturnType<typeof getAdminPrisma>, session.orgId);
        if (!readiness.activation_allowed || row.testedRevision !== row.revision) {
          throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
        }
      }
      await tx.orgSsoConnection.update({ where: { id }, data: { status: body.status, generation: { increment: 1 },
        ...(body.status === 'active' ? {} : { scimEnabled: false, scimRevision: { increment: 1 } }) } });
      if (body.status !== 'active') {
        await tx.scimConnectionToken.updateMany({ where: { connectionId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await lockAndWithdrawConnectionMemberships(id, tx);
      }
      await revokeEnterpriseScope({ scope: 'connection', clientDomain: session.clientDomain, orgId: session.orgId,
        connectionId: id, revision: row.generation + 1 }, tx);
      return { ok: true };
    }));
  });
  app.post(`${base}/sso/domains`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request) => {
    const { email_domain } = z.object({ email_domain: z.string().min(1).max(253) }).strict().parse(request.body);
    return mutation(request, (session, tx) => createEnterpriseDomain(session, email_domain, tx));
  });
  app.post(`${base}/sso/domains/:id/verify`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request) => {
    const { id } = Params.parse(request.params);
    return mutation(request, (session, tx) => verifyEnterpriseDomain(session, id, tx));
  });
  app.post(`${base}/sso/domains/:id/reissue`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request) => {
    z.object({}).strict().parse(request.body);
    const { id } = Params.parse(request.params);
    return mutation(request, (session, tx) => reissueEnterpriseDomain(session, id, tx));
  });
  app.delete(`${base}/sso/domains/:id`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request) => {
    const { id } = Params.parse(request.params);
    return mutation(request, (session, tx) => revokeEnterpriseDomain(session, id, tx));
  });
  app.patch(`${base}/sso/policy`, { preHandler: [requireSameOriginBrowserRequest, limiter] }, async (request) => {
    const body = EnterprisePolicyPatch.parse(request.body);
    return mutation(request, (session, tx) => updateEnterprisePolicy(session, body, tx));
  });
}
