import type { FastifyInstance } from 'fastify';
import {
  BILLING_BROWSER_PATHS as paths,
  billingBrowserTariffRequestV1JsonSchema,
  billingBrowserTariffV1JsonSchema,
  billingBrowserReserveRequestV1JsonSchema,
  billingBrowserReadRequestV1JsonSchema,
  billingBrowserReceiptRequestV1JsonSchema,
  billingBrowserReleaseRequestV1JsonSchema,
  billingBrowserReleasedV1JsonSchema,
  billingBrowserReservationV1JsonSchema,
  type BillingBrowserTariffRequestV1,
  type BillingBrowserReserveRequestV1,
  type BillingBrowserReadRequestV1,
  type BillingBrowserReceiptRequestV1,
  type BillingBrowserReleaseRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { requireBillingBrowserRuntimeAppKey } from '../../middleware/billing-app-auth.js';
import { reserveBrowser, readBrowserTariff } from '../../services/billing-browser-reservation.service.js';
import {
  readBrowserReservation,
  claimBrowser,
  releaseBrowserReservation,
} from '../../services/billing-browser-dispatch.service.js';
import { settleBrowser } from '../../services/billing-browser-receipt.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerBrowserBillingRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingBrowserTariffRequestV1 }>(
    paths.tariff,
    {
      preHandler: [requireBillingBrowserRuntimeAppKey],
      schema: {
        body: billingBrowserTariffRequestV1JsonSchema,
        response: { 200: billingBrowserTariffV1JsonSchema },
      },
    },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return readBrowserTariff({
        request: request.body,
        credential: request.billingAppKey,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
      });
    },
  );
  app.post<{ Body: BillingBrowserReserveRequestV1 }>(
    paths.reserve,
    {
      preHandler: [requireBillingBrowserRuntimeAppKey],
      schema: {
        body: billingBrowserReserveRequestV1JsonSchema,
        response: { 200: billingBrowserReservationV1JsonSchema },
      },
    },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return reserveBrowser({
        request: request.body,
        credential: request.billingAppKey,
        actorToken: readBillingActorHeader(request.headers['x-uoa-actor']),
      });
    },
  );
  for (const [path, action] of [
    [paths.read, readBrowserReservation],
    [paths.claim, claimBrowser],
  ] as const) {
    app.post<{ Body: BillingBrowserReadRequestV1 }>(
      path,
      {
        preHandler: [requireBillingBrowserRuntimeAppKey],
        schema: {
          body: billingBrowserReadRequestV1JsonSchema,
          response: { 200: billingBrowserReservationV1JsonSchema },
        },
      },
      async (request, reply) => {
        if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
        reply.header('Cache-Control', 'private, no-store');
        return action({ request: request.body, credential: request.billingAppKey });
      },
    );
  }
  app.post<{ Body: BillingBrowserReceiptRequestV1 }>(
    paths.receipt,
    {
      preHandler: [requireBillingBrowserRuntimeAppKey],
      schema: {
        body: billingBrowserReceiptRequestV1JsonSchema,
        response: { 200: billingBrowserReservationV1JsonSchema },
      },
    },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return settleBrowser({ request: request.body, credential: request.billingAppKey });
    },
  );
  app.post<{ Body: BillingBrowserReleaseRequestV1 }>(
    paths.release,
    {
      preHandler: [requireBillingBrowserRuntimeAppKey],
      schema: {
        body: billingBrowserReleaseRequestV1JsonSchema,
        response: { 200: billingBrowserReleasedV1JsonSchema },
      },
    },
    async (request, reply) => {
      if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
      reply.header('Cache-Control', 'private, no-store');
      return releaseBrowserReservation({ request: request.body, credential: request.billingAppKey });
    },
  );
}
