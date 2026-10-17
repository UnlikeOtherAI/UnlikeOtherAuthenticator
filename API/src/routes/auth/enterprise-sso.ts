import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { finishEnterpriseTest } from '../../services/org-sso-flow.service.js';
import { finishEnterpriseLogin } from '../../services/org-sso-login.service.js';
import { enterpriseTileRedirect } from '../../services/org-sso-entry.service.js';
import { enterpriseSamlMetadata } from '../../services/org-sso-saml.service.js';
import { AppError } from '../../utils/errors.js';
import { hashAssuranceReference } from '../../services/session-assurance.service.js';

export function registerEnterpriseSsoRoutes(app: FastifyInstance): void {
  const rate = createRateLimiter({ keyBuilder: (request) => `enterprise-callback:${request.ip}`, limit: 20, windowMs: 60000 });
  app.get('/sso/:id/test', { preHandler: rate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    const { flow: flowId } = z.object({ flow: z.string().min(32).max(100) }).strict().parse(request.query);
    const flow = await getAdminPrisma().orgSsoFlow.findUnique({ where: { id: flowId } });
    const browser = request.cookies[`uoa_sso_${flowId}`];
    if (!flow || flow.connectionId !== id || flow.mode !== 'test' || !browser ||
      flow.browserHash !== hashAssuranceReference(browser) || flow.expiresAt <= new Date() || flow.consumedAt) {
      throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
    }
    const target = z.object({ authorize_url: z.string().url() }).parse(flow.context).authorize_url;
    return reply.header('Cache-Control', 'no-store').redirect(target);
  });
  app.get('/sso/oidc/:id/callback', { preHandler: rate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    const body = z.object({ state: z.string().min(32).max(100), code: z.string().max(4096).optional(),
      iss: z.string().max(2000).optional(), error: z.string().max(200).optional() }).passthrough().parse(request.query);
    const browser = request.cookies[`uoa_sso_${body.state}`];
    if (!browser) throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
    const flow = await getAdminPrisma().orgSsoFlow.findUnique({ where: { id: body.state }, select: { mode: true } });
    const result = flow?.mode === 'login' ? await finishEnterpriseLogin(id, body.state, browser,
      { code: body.code, iss: body.iss }, request.ip) :
      { destination: await finishEnterpriseTest(id, body.state, browser, { code: body.code, iss: body.iss }), retainBrowser: false };
    if (!result.retainBrowser) reply.clearCookie(`uoa_sso_${body.state}`, { path: '/sso' });
    return reply.header('Cache-Control', 'no-store').redirect(result.destination);
  });
  app.post('/sso/saml/:id/acs', { preHandler: rate, bodyLimit: 380000 }, async (request, reply) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    const body = z.object({ RelayState: z.string().min(32).max(100), SAMLResponse: z.string().max(360000) }).strict().parse(request.body);
    const browser = request.cookies[`uoa_sso_${body.RelayState}`];
    if (!browser) throw new AppError('UNAUTHORIZED', 401, 'SSO_FLOW_INVALID');
    const flow = await getAdminPrisma().orgSsoFlow.findUnique({ where: { id: body.RelayState }, select: { mode: true } });
    const result = flow?.mode === 'login' ? await finishEnterpriseLogin(id, body.RelayState, browser, body, request.ip) :
      { destination: await finishEnterpriseTest(id, body.RelayState, browser, body), retainBrowser: false };
    if (!result.retainBrowser) reply.clearCookie(`uoa_sso_${body.RelayState}`, { path: '/sso' });
    return reply.header('Cache-Control', 'no-store').redirect(result.destination);
  });
  app.get('/sso/saml/:id/metadata', { preHandler: rate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(request.params);
    const connection = await getAdminPrisma().orgSsoConnection.findUnique({ where: { id } });
    if (!connection || connection.protocol !== 'saml') throw new AppError('NOT_FOUND', 404);
    return reply.header('Cache-Control', 'no-store').type('application/samlmetadata+xml')
      .send(await enterpriseSamlMetadata(connection));
  });
  app.get('/sso/:id/start', { preHandler: rate }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    return reply.header('Cache-Control', 'no-store').redirect(await enterpriseTileRedirect(id));
  });
}
