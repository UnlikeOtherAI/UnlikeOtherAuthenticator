import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  addJwkForDomain,
  deactivateJwk,
  listJwksForDomain,
} from '../../../services/client-jwk.service.js';
import { displayJwkFingerprint } from '../../../utils/display-prefixes.js';
import { normalizeDomain } from '../../../utils/domain.js';
import { AppError } from '../../../utils/errors.js';

const DomainParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
});

const DomainKidParamsSchema = z.object({
  domain: z.string().trim().min(3).transform(normalizeDomain),
  kid: z.string().trim().min(1).max(256),
});

const AddJwkBodySchema = z
  .object({
    jwk: z.unknown(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = { type: 'array', items: objectSchema } as const;

function adminRoute(responseSchema: Record<string, unknown>): RouteShorthandOptions {
  return {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: responseSchema } },
  };
}

function toAdminJwk(row: {
  id: string;
  kid: string;
  fingerprint: string;
  active: boolean;
  createdAt: Date;
  deactivatedAt: Date | null;
  createdByEmail: string | null;
}) {
  return {
    id: row.id,
    kid: row.kid,
    fingerprint: displayJwkFingerprint(row.fingerprint),
    active: row.active,
    created_at: row.createdAt.toISOString(),
    deactivated_at: row.deactivatedAt?.toISOString() ?? null,
    created_by_email: row.createdByEmail,
  };
}

function requireActorEmail(request: { adminAccessTokenClaims?: { email: string } }): string {
  const email = request.adminAccessTokenClaims?.email;
  if (!email) throw new AppError('INTERNAL', 500, 'MISSING_ADMIN_CLAIMS');
  return email;
}

export function registerInternalAdminDomainJwkRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/domains/:domain/jwks',
    adminRoute(arraySchema),
    async (request) => {
      const { domain } = DomainParamsSchema.parse(request.params);
      const rows = await listJwksForDomain(domain);
      return rows.map(toAdminJwk);
    },
  );

  app.post(
    '/internal/admin/domains/:domain/jwks',
    adminRoute(objectSchema),
    async (request) => {
      const { domain } = DomainParamsSchema.parse(request.params);
      const { jwk } = AddJwkBodySchema.parse(request.body ?? {});
      const actorEmail = requireActorEmail(request);

      const row = await addJwkForDomain({ domain, jwk, actorEmail });
      return toAdminJwk(row);
    },
  );

  app.delete(
    '/internal/admin/domains/:domain/jwks/:kid',
    adminRoute(objectSchema),
    async (request) => {
      const { domain, kid } = DomainKidParamsSchema.parse(request.params);
      const actorEmail = requireActorEmail(request);

      const row = await deactivateJwk({ domain, kid, actorEmail });
      return toAdminJwk(row);
    },
  );
}
