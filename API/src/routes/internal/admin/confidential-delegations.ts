import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createConfidentialDelegationMapping,
  deleteConfidentialDelegationMapping,
  listConfidentialDelegationMappings,
  serializeConfidentialDelegationMapping,
  updateConfidentialDelegationMapping,
} from '../../../services/confidential-delegation.service.js';

const ScopeSchema = z.enum(['ai.invoke', 'billing.read']);
const MappingIdSchema = z.object({
  mappingId: z.string().trim().min(1),
});
const CreateMappingSchema = z
  .object({
    source_domain: z.string().trim().min(1).max(253),
    product: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    resource: z.string().trim().min(1).max(2048),
    scopes: z.array(ScopeSchema).min(1).max(2),
    enabled: z.boolean().optional(),
  })
  .strict();
const UpdateMappingSchema = z
  .object({
    resource: z.string().trim().min(1).max(2048).optional(),
    scopes: z.array(ScopeSchema).min(1).max(2).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.resource !== undefined || body.scopes !== undefined || body.enabled !== undefined,
    { message: 'at least one field is required' },
  );

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = {
  type: 'array',
  items: objectSchema,
} as const;
const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
};

function mutationActor(request: FastifyRequest) {
  return {
    userId: request.adminAccessTokenClaims?.userId ?? null,
    email: request.adminAccessTokenClaims?.email ?? 'unknown',
  };
}

export function registerInternalAdminConfidentialDelegationRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/confidential-delegations',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async () =>
      (await listConfidentialDelegationMappings()).map(serializeConfidentialDelegationMapping),
  );

  app.post(
    '/internal/admin/confidential-delegations',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const body = CreateMappingSchema.parse(request.body);
      const created = await createConfidentialDelegationMapping({
        sourceDomain: body.source_domain,
        product: body.product,
        resource: body.resource,
        scopes: body.scopes,
        enabled: body.enabled,
        actor: mutationActor(request),
      });
      return reply.status(201).send(serializeConfidentialDelegationMapping(created));
    },
  );

  app.patch(
    '/internal/admin/confidential-delegations/:mappingId',
    { ...adminRoute, schema: { response: { 200: objectSchema } } },
    async (request) => {
      const { mappingId } = MappingIdSchema.parse(request.params);
      const body = UpdateMappingSchema.parse(request.body);
      return serializeConfidentialDelegationMapping(
        await updateConfidentialDelegationMapping({
          mappingId,
          resource: body.resource,
          scopes: body.scopes,
          enabled: body.enabled,
          actor: mutationActor(request),
        }),
      );
    },
  );

  app.delete(
    '/internal/admin/confidential-delegations/:mappingId',
    adminRoute,
    async (request, reply) => {
      const { mappingId } = MappingIdSchema.parse(request.params);
      await deleteConfidentialDelegationMapping({
        mappingId,
        actor: mutationActor(request),
      });
      return reply.status(204).send();
    },
  );
}
