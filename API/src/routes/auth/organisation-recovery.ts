import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { getAdminPrisma } from '../../db/prisma.js';
import { getPublicBaseUrl } from '../../config/env.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import { managementSession } from '../../services/org-sso-management.service.js';
import { ownerRecoveryView, setRecoveryContacts } from '../../services/enterprise-recovery-policy.service.js';
import { startRecoveryChallenge, completeRecoveryChallenge } from '../../services/enterprise-recovery-action.service.js';
import { renderAuthEntrypointHtml, sendAuthHtml } from '../../services/auth-ui.service.js';
import { readAdminConfigJwt } from '../../services/admin-auth-config.service.js';
import { validateConfigFields } from '../../services/config.service.js';

type OwnerMutation = <T>(request: FastifyRequest, run: (session: Awaited<ReturnType<typeof managementSession>>,
  tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
export function registerOrganisationRecovery(app: FastifyInstance, mutation: OwnerMutation) {
  const rate = createRateLimiter({ keyBuilder: (request) => `enterprise-recovery:${request.ip}`, limit: 30, windowMs: 60000 });
  const owner = '/auth/organisation-access/sso/recovery';
  app.get(owner, { preHandler: rate }, async (request, reply) => {
    const session = await managementSession(request.cookies.uoa_org_access);
    const { cursor } = z.object({ cursor: z.string().min(1).max(100).optional() }).strict().parse(request.query);
    return reply.header('Cache-Control', 'no-store').send(await ownerRecoveryView(session, getAdminPrisma(), cursor));
  });
  app.put(owner, { preHandler: [requireSameOriginBrowserRequest, rate] }, async (request, reply) => {
    const body = z.object({ revision: z.number().int().positive(), custodian_user_ids: z.array(z.string().min(1).max(100)).length(2) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request,
      (session, tx) => setRecoveryContacts(session, body.revision, body.custodian_user_ids, tx)));
  });
  const base = '/auth/organisation-recovery';
  app.get(base, async (request, reply) => {
    const config = validateConfigFields(decodeJwt(readAdminConfigJwt()));
    const html = await renderAuthEntrypointHtml({ config: { ...config, language_config: ['en', 'cs', 'es'] },
      configUrl: `${getPublicBaseUrl()}/internal/admin/config`, requestUrl: request.raw.url, cspNonce: reply.cspNonce?.script });
    sendAuthHtml(reply, html);
  });
  app.post(`${base}/challenge`, { preHandler: [requireSameOriginBrowserRequest, rate] }, async (request, reply) => {
    const body = z.object({ contact: z.string().regex(/^[A-Za-z0-9_-]{43}$/), purpose: z.enum(['confirm', 'drill', 'recover']) }).strict().parse(request.body);
    const browser = randomBytes(32).toString('base64url');
    const result = await startRecoveryChallenge({ ...body, browser });
    reply.setCookie('uoa_recovery', browser, { path: base, httpOnly: true, sameSite: 'strict',
      secure: new URL(getPublicBaseUrl()).protocol === 'https:', maxAge: 300 });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  app.post(`${base}/complete`, { preHandler: [requireSameOriginBrowserRequest, rate] }, async (request, reply) => {
    const body = z.object({ challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().max(20) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await completeRecoveryChallenge({ ...body, browser: request.cookies.uoa_recovery }));
  });
}
