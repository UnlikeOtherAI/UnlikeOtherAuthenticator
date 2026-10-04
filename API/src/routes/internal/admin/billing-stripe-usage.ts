import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import { writeAuditLog } from '../../../services/audit-log.service.js';
import { exportStripeUsage } from '../../../services/billing-stripe-usage.service.js';
import {
  listUncertainStripeUsageExports,
  reconcileStripeUsageExport,
} from '../../../services/billing-stripe-reconciliation.service.js';

const StripeUsageExportSchema = z
  .object({
    subscription_id: z.string().trim().min(1),
    billing_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    ledger_snapshot_cursor: z
      .string()
      .regex(/^bus_[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

const responseSchema = {
  type: 'object',
  required: ['ledger_snapshot_cursor', 'billing_month', 'exports'],
  properties: {
    ledger_snapshot_cursor: { type: 'string' },
    billing_month: { type: 'string' },
    exports: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
} as const;

const ReconcileParamsSchema = z.object({ exportId: z.string().trim().min(1) }).strict();
const ReconcileBodySchema = z.object({
  outcome: z.enum(['accepted', 'not_accepted', 'manual_invoice']),
  evidence_reference: z.string().trim().min(1).max(255),
  observed_at: z.string().datetime(),
}).strict();

export function registerInternalAdminBillingStripeUsageRoute(
  app: FastifyInstance,
): void {
  app.get('/internal/admin/billing/stripe/usage-reconciliations', {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
  }, async () => listUncertainStripeUsageExports());

  app.post('/internal/admin/billing/stripe/usage-reconciliations/:exportId', {
    preHandler: [requireAdminSuperuser],
    schema: { response: { 200: { type: 'object', additionalProperties: true } } },
  }, async (request) => {
    const { exportId } = ReconcileParamsSchema.parse(request.params);
    const body = ReconcileBodySchema.parse(request.body);
    return reconcileStripeUsageExport({
      exportId,
      outcome: body.outcome,
      evidenceReference: body.evidence_reference,
      observedAt: new Date(body.observed_at),
      actorEmail: request.adminAccessTokenClaims?.email ?? 'unknown',
    });
  });

  app.post(
    '/internal/admin/billing/stripe/usage-exports',
    {
      preHandler: [requireAdminSuperuser],
      schema: { response: { 200: responseSchema } },
    },
    async (request) => {
      const body = StripeUsageExportSchema.parse(request.body);
      const result = await exportStripeUsage({
        subscriptionId: body.subscription_id,
        billingMonth: body.billing_month,
        cursor: body.ledger_snapshot_cursor,
      });
      await writeAuditLog({
        actorEmail: request.adminAccessTokenClaims?.email ?? 'unknown',
        action: 'billing.stripe_usage_exported',
        metadata: {
          subscription_id: body.subscription_id,
          billing_month: body.billing_month,
          ledger_snapshot_cursor: result.ledgerSnapshotCursor,
          export_count: result.exports.length,
        },
      });
      return {
        ledger_snapshot_cursor: result.ledgerSnapshotCursor,
        billing_month: result.billingMonth,
        exports: result.exports.map((record) => ({
          id: record.id,
          billing_product: record.billingProduct,
          caller_product: record.callerProduct,
          currency: record.currency,
          cumulative_customer_charge: record.cumulativeCustomerCharge,
          cumulative_meter_quantity: record.cumulativeMeterQuantity,
          delta_meter_quantity: record.deltaMeterQuantity,
          stripe_meter_event_identifier: record.stripeMeterEventIdentifier,
          stripe_meter_event_created_at: record.stripeMeterEventCreatedAt,
        })),
      };
    },
  );
}
