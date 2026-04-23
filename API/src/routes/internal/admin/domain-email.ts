import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  deleteDomainEmailConfig,
  getDomainEmailConfig,
  refreshDomainEmailStatus,
  registerDomainEmailSender,
  setDomainEmailEnabled,
  upsertDomainEmailConfig,
} from '../../../services/domain-email-config.service.js';
import { normalizeDomain } from '../../../utils/domain.js';

const DomainParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
});

const ConfigBodySchema = z
  .object({
    mailingDomain: z.string().trim().min(3),
    fromAddress: z.string().trim().email(),
    fromName: z.string().trim().optional(),
    replyToDefault: z.string().trim().email().optional(),
  })
  .strict();

const EnabledBodySchema = z.object({ enabled: z.boolean() }).strict();
const objectSchema = { type: 'object', additionalProperties: true } as const;
const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
  schema: { response: { 200: objectSchema } },
};

export function registerInternalAdminDomainEmailRoutes(app: FastifyInstance): void {
  app.get('/internal/admin/domains/:domain/email', adminRoute, async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    return getDomainEmailConfig(domain);
  });

  app.put('/internal/admin/domains/:domain/email', adminRoute, async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const body = ConfigBodySchema.parse(request.body);
    return { config: await upsertDomainEmailConfig(domain, body) };
  });

  app.post('/internal/admin/domains/:domain/email/register', adminRoute, async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    return registerDomainEmailSender(domain);
  });

  app.post('/internal/admin/domains/:domain/email/refresh', adminRoute, async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    return refreshDomainEmailStatus(domain);
  });

  app.patch('/internal/admin/domains/:domain/email/enabled', adminRoute, async (request) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    const { enabled } = EnabledBodySchema.parse(request.body);
    return { config: await setDomainEmailEnabled(domain, enabled) };
  });

  app.delete('/internal/admin/domains/:domain/email', { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
    const { domain } = DomainParamsSchema.parse(request.params);
    await deleteDomainEmailConfig(domain);
    return reply.status(204).send();
  });
}
