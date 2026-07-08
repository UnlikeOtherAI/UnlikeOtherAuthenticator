import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createAdminApiKey,
  listAdminApiKeys,
  revokeAdminApiKey,
  type AdminApiKeyRecord,
} from '../../../services/admin-api-key.service.js';

// HUGO-539: key management is superuser-UI-only — the escalation boundary. An Admin API key
// can NEVER mint/list/revoke keys, so all three routes keep requireAdminSuperuser.

const IdParamsSchema = z.object({ id: z.string().trim().min(1) });
const CreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // ISO-8601 datetime; optional. null/absent ⇒ never expires.
    expires_at: z.string().datetime().nullable().optional(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = { type: 'array', items: { type: 'object', additionalProperties: true } } as const;

const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
};

function serializeRecord(record: AdminApiKeyRecord) {
  return {
    id: record.id,
    name: record.name,
    key_prefix: record.keyPrefix,
    last_used_at: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
    expires_at: record.expiresAt ? record.expiresAt.toISOString() : null,
    revoked_at: record.revokedAt ? record.revokedAt.toISOString() : null,
    created_by_email: record.createdByEmail,
    created_at: record.createdAt.toISOString(),
  };
}

export function registerInternalAdminApiKeyRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/api-keys',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async () => (await listAdminApiKeys()).map(serializeRecord),
  );

  app.post(
    '/internal/admin/api-keys',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const body = CreateBodySchema.parse(request.body);
      const claims = request.adminAccessTokenClaims;
      const { record, plaintext } = await createAdminApiKey({
        name: body.name,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        createdBy: { userId: claims?.userId ?? null, email: claims?.email ?? null },
      });
      // Plaintext is returned exactly once — never persisted, never shown again.
      return reply.status(201).send({ ...serializeRecord(record), key: plaintext });
    },
  );

  app.delete('/internal/admin/api-keys/:id', adminRoute, async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    await revokeAdminApiKey(id);
    return reply.status(204).send();
  });
}
