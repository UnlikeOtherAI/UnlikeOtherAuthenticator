import type { FastifyInstance } from 'fastify';
import {
  BILLING_SMS_PATHS, billingSmsNumberBeginRequestV1JsonSchema, billingSmsNumberStatusRequestV1JsonSchema,
  billingSmsNumberRuntimeStatusRequestV1JsonSchema, billingSmsNumberAttachRequestV1JsonSchema,
  billingSmsNumberEndRequestV1JsonSchema, billingSmsNumberV1JsonSchema, billingSmsNumberEndResultV1JsonSchema,
  billingSmsResourceNotFoundV1JsonSchema,
  type BillingSmsNumberBeginRequestV1, type BillingSmsNumberStatusRequestV1,
  type BillingSmsNumberRuntimeStatusRequestV1, type BillingSmsNumberAttachRequestV1,
  type BillingSmsNumberEndRequestV1,
} from '@unlikeotherai/billing-statement-protocol';
import { requireBillingLifecycleAppKey, requireBillingEntitlementAppKey,
  requireBillingSmsRuntimeAppKey } from '../../middleware/billing-app-auth.js';
import { beginSmsNumber, readSmsNumber } from '../../services/billing-sms-number.service.js';
import { attachSmsNumber, endSmsNumber } from '../../services/billing-sms-number-lifecycle.service.js';
import { configuredSmsProvider } from '../../services/billing-sms-runtime.service.js';
import { verifySmsActor, smsSubject } from '../../services/billing-sms-authority.service.js';
import { resolveBillingFundingViewer } from '../../services/billing-funding-viewer.service.js';
import { assertCanManageRecurringAddonScope } from '../../services/billing-recurring-addon-scope.service.js';
import { AppError } from '../../utils/errors.js';
import { readBillingActorHeader } from './billing-request.js';

export function registerSmsNumberRoutes(app: FastifyInstance): void {
  app.post<{ Body: BillingSmsNumberBeginRequestV1 }>(BILLING_SMS_PATHS.numberBegin, {
    preHandler: [requireBillingLifecycleAppKey], schema: {
      body: billingSmsNumberBeginRequestV1JsonSchema, response: { 200: billingSmsNumberV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return beginSmsNumber({ request: request.body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']) }, { provider: configuredSmsProvider() });
  });
  app.post<{ Body: BillingSmsNumberStatusRequestV1 }>(BILLING_SMS_PATHS.numberStatus, {
    preHandler: [requireBillingEntitlementAppKey], schema: {
      body: billingSmsNumberStatusRequestV1JsonSchema, response: { 200: billingSmsNumberV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    await verifySmsActor({ subject: request.body, credential: request.billingAppKey,
      actorToken: readBillingActorHeader(request.headers['x-uoa-actor']), endpoint: BILLING_SMS_PATHS.numberStatus });
    assertCanManageRecurringAddonScope(await resolveBillingFundingViewer(smsSubject(request.body)), 'ORGANISATION');
    const result = await readSmsNumber({ ...request.body, credential: request.billingAppKey },
      { provider: configuredSmsProvider() });
    if (result.organisation_id !== request.body.organisation_id) throw new AppError('NOT_FOUND', 404);
    reply.header('Cache-Control', 'private, no-store');
    return result;
  });
  app.post<{ Body: BillingSmsNumberRuntimeStatusRequestV1 }>(BILLING_SMS_PATHS.numberRuntimeStatus, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsNumberRuntimeStatusRequestV1JsonSchema,
      response: { 200: billingSmsNumberV1JsonSchema, 404: billingSmsResourceNotFoundV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    try {
      return await readSmsNumber({ ...request.body, credential: request.billingAppKey },
        { provider: configuredSmsProvider() });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404 && error.message === 'BILLING_SMS_RESOURCE_NOT_FOUND') {
        return reply.code(404).send({ code: 'BILLING_SMS_RESOURCE_NOT_FOUND', resource_id: request.body.resource_id });
      }
      throw error;
    }
  });
  app.post<{ Body: BillingSmsNumberAttachRequestV1 }>(BILLING_SMS_PATHS.numberAttach, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsNumberAttachRequestV1JsonSchema, response: { 200: billingSmsNumberV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return attachSmsNumber({ request: request.body, credential: request.billingAppKey }, { provider: configuredSmsProvider() });
  });
  app.post<{ Body: BillingSmsNumberEndRequestV1 }>(BILLING_SMS_PATHS.numberEnd, {
    preHandler: [requireBillingSmsRuntimeAppKey], schema: {
      body: billingSmsNumberEndRequestV1JsonSchema, response: { 200: billingSmsNumberEndResultV1JsonSchema },
    },
  }, async (request, reply) => {
    if (!request.billingAppKey) throw new AppError('UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'private, no-store');
    return endSmsNumber({ request: request.body, credential: request.billingAppKey }, { provider: configuredSmsProvider() });
  });
}
