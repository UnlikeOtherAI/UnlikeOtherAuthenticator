import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  createBillingAppKey,
  listBillingAppKeys,
  revokeBillingAppKey,
} from '../../../services/billing-app-key.service.js';
import {
  createBillingService,
  createBillingTariffVersion,
  listBillingServices,
  removeBillingTariffAssignment,
  setDefaultBillingTariff,
  upsertBillingTariffAssignment,
} from '../../../services/billing-tariff.service.js';
import {
  serializeBillingAppKey,
  serializeBillingService,
  serializeBillingTariff,
} from './billing-serialization.js';

const IdParamsSchema = z.object({
  serviceId: z.string().trim().min(1),
});
const AssignmentParamsSchema = IdParamsSchema.extend({
  assignmentId: z.string().trim().min(1),
});
const AppKeyParamsSchema = IdParamsSchema.extend({
  keyId: z.string().trim().min(1),
});
const MonthlySchema = z
  .object({
    amount_minor: z.string().regex(/^(0|[1-9]\d*)$/),
    currency: z.string().trim().length(3),
  })
  .strict();
const TariffSchema = z
  .object({
    key: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    mode: z.enum(['standard', 'free', 'at_cost', 'custom']),
    markup_bps: z.number().int().min(0).max(100_000),
    monthly_subscription: MonthlySchema,
  })
  .strict();
const CreateServiceSchema = z
  .object({
    identifier: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    default_tariff: TariffSchema,
  })
  .strict();
const CreateTariffSchema = TariffSchema.extend({
  set_as_default: z.boolean().default(false),
}).strict();
const SetDefaultSchema = z.object({ tariff_id: z.string().trim().min(1) }).strict();
const AssignmentSchema = z
  .object({
    tariff_id: z.string().trim().min(1),
    organisation_id: z.string().trim().min(1),
    team_id: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
const CreateAppKeySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    actor_issuer: z.string().trim().url(),
    actor_audience: z.string().trim().url(),
    actor_public_jwk: z.record(z.unknown()),
    expires_at: z.string().datetime().nullable().optional(),
  })
  .strict();

const objectSchema = { type: 'object', additionalProperties: true } as const;
const arraySchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: true },
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

function tariffInput(body: z.infer<typeof TariffSchema>) {
  return {
    key: body.key,
    name: body.name,
    mode: body.mode,
    markupBps: body.markup_bps,
    monthlyAmountMinor: body.monthly_subscription.amount_minor,
    currency: body.monthly_subscription.currency,
  };
}

export function registerInternalAdminBillingRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/billing/services',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async () => (await listBillingServices()).map(serializeBillingService),
  );

  app.post(
    '/internal/admin/billing/services',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const body = CreateServiceSchema.parse(request.body);
      const service = await createBillingService({
        identifier: body.identifier,
        name: body.name,
        defaultTariff: tariffInput(body.default_tariff),
        actor: mutationActor(request),
      });
      return reply.status(201).send(
        serializeBillingService({
          ...service,
          assignments: [],
          appKeys: [],
        }),
      );
    },
  );

  app.post(
    '/internal/admin/billing/services/:serviceId/tariffs',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const { serviceId } = IdParamsSchema.parse(request.params);
      const body = CreateTariffSchema.parse(request.body);
      const tariff = await createBillingTariffVersion({
        serviceId,
        tariff: tariffInput(body),
        setAsDefault: body.set_as_default,
        actor: mutationActor(request),
      });
      return reply.status(201).send(serializeBillingTariff(tariff));
    },
  );

  app.put(
    '/internal/admin/billing/services/:serviceId/default-tariff',
    { ...adminRoute, schema: { response: { 200: objectSchema } } },
    async (request) => {
      const { serviceId } = IdParamsSchema.parse(request.params);
      const body = SetDefaultSchema.parse(request.body);
      return serializeBillingTariff(
        await setDefaultBillingTariff({
          serviceId,
          tariffId: body.tariff_id,
          actor: mutationActor(request),
        }),
      );
    },
  );

  app.put(
    '/internal/admin/billing/services/:serviceId/assignments',
    { ...adminRoute, schema: { response: { 200: objectSchema } } },
    async (request) => {
      const { serviceId } = IdParamsSchema.parse(request.params);
      const body = AssignmentSchema.parse(request.body);
      const assignment = await upsertBillingTariffAssignment({
        serviceId,
        tariffId: body.tariff_id,
        organisationId: body.organisation_id,
        teamId: body.team_id,
        actor: mutationActor(request),
      });
      return {
        id: assignment.id,
        service_id: assignment.serviceId,
        tariff_id: assignment.tariffId,
        organisation_id: assignment.orgId,
        team_id: assignment.teamId,
        scope: assignment.scope.toLowerCase(),
        tariff: serializeBillingTariff(assignment.tariff),
      };
    },
  );

  app.delete(
    '/internal/admin/billing/services/:serviceId/assignments/:assignmentId',
    adminRoute,
    async (request, reply) => {
      const { serviceId, assignmentId } = AssignmentParamsSchema.parse(request.params);
      await removeBillingTariffAssignment({
        serviceId,
        assignmentId,
        actor: mutationActor(request),
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/internal/admin/billing/services/:serviceId/app-keys',
    { ...adminRoute, schema: { response: { 200: arraySchema } } },
    async (request) => {
      const { serviceId } = IdParamsSchema.parse(request.params);
      return (await listBillingAppKeys(serviceId)).map(serializeBillingAppKey);
    },
  );

  app.post(
    '/internal/admin/billing/services/:serviceId/app-keys',
    { ...adminRoute, schema: { response: { 201: objectSchema } } },
    async (request, reply) => {
      const { serviceId } = IdParamsSchema.parse(request.params);
      const body = CreateAppKeySchema.parse(request.body);
      const { record, plaintext } = await createBillingAppKey({
        serviceId,
        name: body.name,
        actorIssuer: body.actor_issuer,
        actorAudience: body.actor_audience,
        actorPublicJwk: body.actor_public_jwk,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        createdBy: mutationActor(request),
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(201).send({ ...serializeBillingAppKey(record), key: plaintext });
    },
  );

  app.delete(
    '/internal/admin/billing/services/:serviceId/app-keys/:keyId',
    adminRoute,
    async (request, reply) => {
      const { serviceId, keyId } = AppKeyParamsSchema.parse(request.params);
      await revokeBillingAppKey({
        serviceId,
        keyId,
        actorEmail: mutationActor(request).email,
      });
      return reply.status(204).send();
    },
  );
}
