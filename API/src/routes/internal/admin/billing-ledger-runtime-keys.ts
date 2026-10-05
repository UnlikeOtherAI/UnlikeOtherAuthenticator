import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { getAdminPrisma } from '../../../db/prisma.js';
import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createLedgerRuntimeKey, revokeLedgerRuntimeKey,
} from '../../../services/billing-ledger-runtime-key.service.js';

const CreateSchema = z.object({
  product: z.string().min(1).max(100),
  ledger_audience: z.string().url(),
  source_domain: z.string().min(1).max(255),
}).strict();
const ParamsSchema = z.object({ keyId: z.string().min(1) }).strict();

export function registerInternalAdminLedgerRuntimeKeyRoutes(app: FastifyInstance): void {
  app.post('/internal/admin/billing/ledger-runtime-keys',
    { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
      const body = CreateSchema.parse(request.body);
      const result = await createLedgerRuntimeKey({
        product: body.product,
        ledgerAudience: body.ledger_audience,
        sourceDomain: body.source_domain,
        actorEmail: request.adminAccessTokenClaims?.email ?? 'unknown',
      });
      reply.header('Cache-Control', 'no-store');
      return { id: result.id, key_prefix: result.keyPrefix,
        created_at: result.createdAt.toISOString(), secret: result.secret };
    });
  app.get('/internal/admin/billing/ledger-runtime-keys',
    { preHandler: [requireAdminSuperuser] }, async (_request, reply) => {
      const keys = await getAdminPrisma().billingLedgerRuntimeKey.findMany({
        orderBy: { createdAt: 'desc' },
        include: { service: { select: { identifier: true } } },
      });
      reply.header('Cache-Control', 'no-store');
      return { keys: keys.map((key) => ({ id: key.id, product: key.service.identifier,
        key_prefix: key.keyPrefix, ledger_audience: key.ledgerAudience,
        source_domain: key.sourceDomain, created_at: key.createdAt.toISOString(),
        revoked_at: key.revokedAt?.toISOString() ?? null })) };
    });
  app.post('/internal/admin/billing/ledger-runtime-keys/:keyId/revoke',
    { preHandler: [requireAdminSuperuser] }, async (request, reply) => {
      const { keyId } = ParamsSchema.parse(request.params);
      const key = await revokeLedgerRuntimeKey(keyId,
        request.adminAccessTokenClaims?.email ?? 'unknown');
      reply.header('Cache-Control', 'no-store');
      return { id: key.id, revoked_at: key.revokedAt?.toISOString() ?? null };
    });
}
