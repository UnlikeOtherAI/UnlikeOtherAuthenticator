import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { registerRevocationConsumer } from '../../../services/org-sso-delivery.service.js';
import { lockEnterpriseOutbox, revokeEnterpriseScope } from '../../../services/org-sso-revocation.service.js';
import { lockEnterpriseScope } from '../../../services/org-sso-management.service.js';
import { resolveProductTeamPolicy } from '../../../services/product-team-policy.service.js';
import { AppError } from '../../../utils/errors.js';
import { getAdminPrisma } from '../../../db/prisma.js';
import { assertConfigDomainMatchesConfigUrl } from '../../../services/config.service.js';
import { lockProductTeamPolicyShared } from '../../../services/product-team-policy-lock.service.js';
import { lockAndWithdrawConnectionMemberships } from '../../../services/membership-provenance.service.js';

export function registerAdminEnterpriseRevocationRoutes(app: FastifyInstance): void {
  app.put('/internal/admin/enterprise/products/:domain', { preHandler: requireAdminSuperuser }, async (request, reply) => {
    const { domain } = z.object({ domain: z.string().min(1).max(256) }).parse(request.params);
    const input = z.object({ minimum_assurance_version: z.literal(1), authority_migration_revision: z.string().min(1).max(200),
      revocation_consumers_revision: z.string().min(1).max(200), login_entry_url: z.string().url().max(2048),
      config_url: z.string().url().max(2048) }).strict().parse(request.body);
    for (const value of [input.login_entry_url, input.config_url]) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
        throw new AppError('BAD_REQUEST', 400, 'SSO_RELYING_ENTRY_INVALID');
      }
    }
    assertConfigDomainMatchesConfigUrl(domain, input.config_url);
    const result = await getAdminPrisma().$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      if (!(await tx.clientDomain.findUnique({ where: { domain }, select: { status: true } }))?.status) {
        throw new AppError('NOT_FOUND', 404);
      }
      const data = { minimumAssuranceVersion: 1, authorityMigrationRevision: input.authority_migration_revision,
        revocationConsumersRevision: input.revocation_consumers_revision, loginEntryUrl: input.login_entry_url, configUrl: input.config_url };
      return tx.enterpriseProductReadiness.upsert({ where: { clientDomain: domain },
        create: { clientDomain: domain, ...data }, update: data });
    });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, client_domain: result.clientDomain,
      minimum_assurance_version: result.minimumAssuranceVersion, login_entry_url: result.loginEntryUrl, config_url: result.configUrl });
  });
  app.post('/internal/admin/enterprise/arrangements', { preHandler: requireAdminSuperuser }, async (request, reply) => {
    const input = z.object({ client_domain: z.string().min(1).max(256), org_id: z.string().min(1).max(100),
      enabled: z.boolean(), revision: z.number().int().nonnegative() }).strict().parse(request.body);
    const result = await getAdminPrisma().$transaction(async (tx) => {
      await lockEnterpriseOutbox(tx);
      await lockProductTeamPolicyShared(tx);
      await lockEnterpriseScope(tx, input.client_domain, input.org_id);
      const [client, org, product] = await Promise.all([
        tx.clientDomain.findUnique({ where: { domain: input.client_domain } }),
        tx.organisation.findUnique({ where: { id: input.org_id } }),
        resolveProductTeamPolicy({ domain: input.client_domain }, { prisma: tx }),
      ]);
      if (!client || client.status !== 'active' || !org || org.lifecycleStatus !== 'ACTIVE' ||
        (org.domain !== input.client_domain && product.scope !== 'all_active_memberships')) {
        throw new AppError('BAD_REQUEST', 400, 'SSO_PRODUCT_ORG_INVALID');
      }
      const scope = { clientDomain: input.client_domain, orgId: input.org_id };
      const prior = await tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: scope } });
      if ((prior?.revision ?? 0) !== input.revision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
      const row = await tx.orgSsoPolicy.upsert({ where: { clientDomain_orgId: scope },
        create: { ...scope, arrangementEnabled: input.enabled, revision: 1 },
        update: { arrangementEnabled: input.enabled, revision: { increment: 1 }, generation: { increment: 1 } } });
      if (!input.enabled) {
        const connections = await tx.orgSsoConnection.findMany({ where: scope, select: { id: true } });
        await tx.orgSsoConnection.updateMany({ where: scope, data: { status: 'suspended', generation: { increment: 1 },
          scimEnabled: false, scimRevision: { increment: 1 } } });
        await tx.scimConnectionToken.updateMany({ where: { connectionId: { in: connections.map((connection) => connection.id) },
          revokedAt: null }, data: { revokedAt: new Date() } });
        for (const connection of connections) await lockAndWithdrawConnectionMemberships(connection.id, tx);
        await revokeEnterpriseScope({ ...scope, scope: 'product_org', revision: row.generation }, tx);
      }
      return { ok: true, client_domain: row.clientDomain, org_id: row.orgId,
        arrangement_enabled: row.arrangementEnabled, revision: row.revision };
    });
    return reply.header('Cache-Control', 'no-store').send(result);
  });
  const path = '/internal/admin/enterprise/revocation-consumers';
  app.get(path, { preHandler: requireAdminSuperuser }, async (_request, reply) => {
    const rows = await getAdminPrisma().orgRevocationConsumer.findMany({ select: { clientDomain: true,
      destination: true, keyId: true, enabled: true, acknowledgedAt: true, capabilityVersion: true, failureCount: true } });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, data: rows });
  });
  app.post(path, { preHandler: requireAdminSuperuser }, async (request, reply) => {
    const body = z.object({ client_domain: z.string().trim().min(1).max(256), destination: z.string().url().max(2000),
      key_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict().parse(request.body);
    const result = await registerRevocationConsumer(body);
    return reply.header('Cache-Control', 'no-store').send(result);
  });
}
