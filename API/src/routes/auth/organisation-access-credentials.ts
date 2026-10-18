import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { requireSameOriginBrowserRequest } from '../../middleware/same-origin-browser.js';
import { createRateLimiter } from '../../middleware/rate-limiter.js';
import type { managementSession } from '../../services/org-sso-management.service.js';
import { parseEnterpriseIdpMetadata } from '../../services/enterprise-saml-metadata.service.js';
import { rotateEnterpriseCredential, rotateEnterpriseSpKey } from '../../services/enterprise-credential-rotation.service.js';

type OwnerMutation = <T>(request: FastifyRequest, run: (session: Awaited<ReturnType<typeof managementSession>>,
  tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
export function registerOrganisationAccessCredentials(app: FastifyInstance, mutation: OwnerMutation) {
  const base = '/auth/organisation-access/sso/connections/:id';
  const rate = createRateLimiter({ keyBuilder: (request) => `enterprise-credentials:${request.ip}`, limit: 12, windowMs: 60000 });
  const preHandler = [requireSameOriginBrowserRequest, rate];
  const Params = z.object({ id: z.string().min(1).max(100) });
  app.post(`${base}/metadata/parse`, { preHandler, bodyLimit: 300000 }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const { xml } = z.object({ xml: z.string().min(1).max(262144) }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request, async (session, tx) => {
      const row = await tx.orgSsoConnection.findFirst({ where: { id, clientDomain: session.clientDomain, orgId: session.orgId } });
      if (!row || row.protocol !== 'saml') throw new AppError('BAD_REQUEST', 400, 'SSO_METADATA_INVALID');
      return { ok: true, configuration: parseEnterpriseIdpMetadata(xml) };
    }));
  });
  app.post(`${base}/credentials/rotate`, { preHandler }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const body = z.object({ revision: z.number().int().positive(), secret: z.string().min(1).max(20000).optional(),
      certificates: z.array(z.string().min(100).max(20000)).min(1).max(3).optional() }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request, (session, tx) => rotateEnterpriseCredential(session, id, body, tx)));
  });
  app.post(`${base}/sp-key/:action`, { preHandler }, async (request, reply) => {
    const { id, action } = Params.extend({ action: z.enum(['prepare', 'activate', 'retire']) }).parse(request.params);
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
    return reply.header('Cache-Control', 'no-store').send(await mutation(request, (session, tx) => rotateEnterpriseSpKey(session, id, revision, action, tx)));
  });
}
