import { BillingInvoiceStatus } from '@prisma/client';
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  activateBillingContractVersion,
  createBillingContract,
  createBillingContractVersion,
  listBillingContracts,
} from '../../../services/billing-contract.service.js';
import { calculateBillingContractInvoice } from '../../../services/billing-invoice-calculation.service.js';
import {
  getBillingInvoice,
  issueBillingInvoice,
  listBillingInvoices,
  readBillingInvoicePdf,
  recordBillingInvoicePayment,
  voidBillingInvoice,
} from '../../../services/billing-invoice-lifecycle.service.js';
import {
  createBillingInvoiceIssuerProfile,
  getOrganisationInvoiceProfile,
  listBillingInvoiceIssuerProfiles,
  upsertOrganisationInvoiceProfile,
} from '../../../services/billing-invoice-profile.service.js';
import { resolveBillingInvoiceIssueActions } from '../../../services/billing-invoice-action-readiness.service.js';
import {
  serializeCustomerSafeInvoice,
  type CustomerSafeInvoice,
} from '../../../services/billing-invoice-view.service.js';
import {
  currentBillingMonth,
  serializeBillingContract,
  serializeContractVersion,
  serializeInvoiceBuyer,
  serializeInvoiceIssuer,
} from './billing-contract-invoice-serializers.js';
import {
  buyerProfileResponseSchema,
  contractArrayResponseSchema,
  contractResponseSchema,
  contractVersionResponseSchema,
  invoiceArraySchema,
  invoiceResponseSchema,
  issuerProfileArrayResponseSchema,
  issuerProfileResponseSchema,
} from './billing-contract-invoice-response-schemas.js';

const IdentifierSchema = z.string().trim().min(1).max(256);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const CurrencySchema = z.string().trim().length(3);
const AddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(1).max(120).optional(),
    postal_code: z.string().trim().min(1).max(32),
    country: z.string().trim().length(2),
  })
  .strict();
const ContractParamsSchema = z.object({ contractId: IdentifierSchema }).strict();
const VersionParamsSchema = ContractParamsSchema.extend({ versionId: IdentifierSchema }).strict();
const InvoiceParamsSchema = z.object({ invoiceId: IdentifierSchema }).strict();
const OrganisationParamsSchema = z.object({ organisationId: IdentifierSchema }).strict();
const ActorBodySchema = z.object({}).strict();

const adminRoute: RouteShorthandOptions = {
  preHandler: [requireAdminSuperuser],
  onSend: async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  },
};

function actor(request: FastifyRequest) {
  return {
    userId: request.adminAccessTokenClaims?.userId ?? null,
    tokenVersion: request.adminAccessTokenClaims?.tokenVersion ?? null,
    email: request.adminAccessTokenClaims?.email ?? 'unknown',
  };
}

async function serializeInvoices(invoices: CustomerSafeInvoice[]) {
  const issueActions = await resolveBillingInvoiceIssueActions(invoices);
  return invoices.map((invoice) =>
    serializeCustomerSafeInvoice(invoice, issueActions.get(invoice.id) ?? null),
  );
}

async function serializeInvoice(invoice: CustomerSafeInvoice) {
  const issueActions = await resolveBillingInvoiceIssueActions([invoice]);
  return serializeCustomerSafeInvoice(invoice, issueActions.get(invoice.id) ?? null);
}

export function registerInternalAdminBillingContractInvoiceRoutes(app: FastifyInstance): void {
  app.get(
    '/internal/admin/billing/contracts',
    { ...adminRoute, schema: { response: { 200: contractArrayResponseSchema } } },
    async (request) => {
      const query = z.object({ organisation_id: IdentifierSchema.optional() }).parse(request.query);
      return (await listBillingContracts({ organisationId: query.organisation_id })).map(
        serializeBillingContract,
      );
    },
  );

  app.post(
    '/internal/admin/billing/contracts',
    { ...adminRoute, schema: { response: { 201: contractResponseSchema } } },
    async (request, reply) => {
      const body = z
        .object({
          organisation_id: IdentifierSchema,
          reference: z.string().trim().min(1).max(100),
          name: z.string().trim().min(1).max(160),
        })
        .strict()
        .parse(request.body);
      const contract = await createBillingContract({
        organisationId: body.organisation_id,
        reference: body.reference,
        name: body.name,
        actor: actor(request),
      });
      return reply.status(201).send(serializeBillingContract(contract));
    },
  );

  app.post(
    '/internal/admin/billing/contracts/:contractId/versions',
    { ...adminRoute, schema: { response: { 201: contractVersionResponseSchema } } },
    async (request, reply) => {
      const { contractId } = ContractParamsSchema.parse(request.params);
      const body = z
        .object({
          usage_markup_bps: z.number().int().min(0).max(100_000),
          currency: CurrencySchema,
          payment_terms_days: z.number().int().min(0).max(365),
          effective_from_month: MonthSchema,
        })
        .strict()
        .parse(request.body);
      const version = await createBillingContractVersion({
        contractId,
        usageMarkupBps: body.usage_markup_bps,
        currency: body.currency,
        paymentTermsDays: body.payment_terms_days,
        effectiveFromMonth: body.effective_from_month,
        actor: actor(request),
      });
      return reply
        .status(201)
        .send(
          serializeContractVersion(
            version,
            version.effectiveFromMonth > currentBillingMonth() ? 'scheduled' : 'ready',
          ),
        );
    },
  );

  app.post(
    '/internal/admin/billing/contracts/:contractId/versions/:versionId/activate',
    { ...adminRoute, schema: { response: { 200: contractVersionResponseSchema } } },
    async (request) => {
      const { contractId, versionId } = VersionParamsSchema.parse(request.params);
      const body = z
        .object({
          services: z
            .array(
              z
                .object({
                  service_id: IdentifierSchema,
                  monthly_amount_minor: z.string().regex(/^(0|[1-9]\d*)$/),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict()
        .parse(request.body);
      const version = await activateBillingContractVersion({
        contractId,
        contractVersionId: versionId,
        services: body.services.map((service) => ({
          serviceId: service.service_id,
          monthlyAmountMinor: service.monthly_amount_minor,
        })),
        actor: actor(request),
      });
      return serializeContractVersion(version, 'active');
    },
  );

  app.get(
    '/internal/admin/billing/invoice-issuer-profiles',
    { ...adminRoute, schema: { response: { 200: issuerProfileArrayResponseSchema } } },
    async () => (await listBillingInvoiceIssuerProfiles()).map(serializeInvoiceIssuer),
  );

  app.post(
    '/internal/admin/billing/invoice-issuer-profiles',
    { ...adminRoute, schema: { response: { 201: issuerProfileResponseSchema } } },
    async (request, reply) => {
      const body = z
        .object({
          key: z.string().trim().min(1).max(80),
          legal_name: z.string().trim().min(1).max(200),
          trading_name: z.string().trim().min(1).max(200).nullable().optional(),
          billing_email: z.string().trim().email(),
          address: AddressSchema,
          tax_identifier: z.string().trim().min(1).max(100).nullable().optional(),
          company_registration_number: z.string().trim().min(1).max(100).nullable().optional(),
          invoice_number_prefix: z.string().trim().min(1).max(32),
        })
        .strict()
        .parse(request.body);
      const profile = await createBillingInvoiceIssuerProfile({
        key: body.key,
        legalName: body.legal_name,
        tradingName: body.trading_name,
        billingEmail: body.billing_email,
        address: body.address,
        taxIdentifier: body.tax_identifier,
        companyRegistrationNumber: body.company_registration_number,
        invoiceNumberPrefix: body.invoice_number_prefix,
        actor: actor(request),
      });
      return reply.status(201).send(serializeInvoiceIssuer(profile));
    },
  );

  app.get(
    '/internal/admin/billing/organisations/:organisationId/invoice-profile',
    { ...adminRoute, schema: { response: { 200: buyerProfileResponseSchema } } },
    async (request) => {
      const { organisationId } = OrganisationParamsSchema.parse(request.params);
      return serializeInvoiceBuyer(await getOrganisationInvoiceProfile(organisationId));
    },
  );

  app.put(
    '/internal/admin/billing/organisations/:organisationId/invoice-profile',
    { ...adminRoute, schema: { response: { 200: buyerProfileResponseSchema } } },
    async (request) => {
      const { organisationId } = OrganisationParamsSchema.parse(request.params);
      const body = z
        .object({
          legal_name: z.string().trim().min(1).max(200),
          billing_email: z.string().trim().email(),
          billing_address: AddressSchema,
          tax_identifier: z.string().trim().min(1).max(100).nullable().optional(),
          purchase_order_reference: z.string().trim().min(1).max(120).nullable().optional(),
        })
        .strict()
        .parse(request.body);
      return serializeInvoiceBuyer(
        await upsertOrganisationInvoiceProfile({
          organisationId,
          legalName: body.legal_name,
          billingEmail: body.billing_email,
          billingAddress: body.billing_address,
          taxIdentifier: body.tax_identifier,
          purchaseOrderReference: body.purchase_order_reference,
          actor: actor(request),
        }),
      );
    },
  );

  app.post(
    '/internal/admin/billing/invoices/calculate',
    { ...adminRoute, schema: { response: { 201: invoiceResponseSchema } } },
    async (request, reply) => {
      const body = z
        .object({
          contract_id: IdentifierSchema,
          issuer_profile_id: IdentifierSchema,
          billing_month: MonthSchema,
        })
        .strict()
        .parse(request.body);
      const invoice = await calculateBillingContractInvoice({
        contractId: body.contract_id,
        issuerProfileId: body.issuer_profile_id,
        billingMonth: body.billing_month,
        actor: actor(request),
      });
      return reply.status(201).send(await serializeInvoice(invoice));
    },
  );

  app.get(
    '/internal/admin/billing/invoices',
    { ...adminRoute, schema: { response: { 200: invoiceArraySchema } } },
    async (request) => {
      const query = z
        .object({
          organisation_id: IdentifierSchema.optional(),
          contract_id: IdentifierSchema.optional(),
          billing_month: MonthSchema.optional(),
          status: z.enum(['draft', 'issuing', 'issued', 'void']).optional(),
        })
        .strict()
        .parse(request.query);
      return serializeInvoices(
        await listBillingInvoices({
          organisationId: query.organisation_id,
          contractId: query.contract_id,
          billingMonth: query.billing_month,
          status: query.status?.toUpperCase() as BillingInvoiceStatus | undefined,
        }),
      );
    },
  );

  app.get(
    '/internal/admin/billing/invoices/:invoiceId',
    { ...adminRoute, schema: { response: { 200: invoiceResponseSchema } } },
    async (request) => {
      const { invoiceId } = InvoiceParamsSchema.parse(request.params);
      return serializeInvoice(await getBillingInvoice(invoiceId));
    },
  );

  app.post(
    '/internal/admin/billing/invoices/:invoiceId/issue',
    { ...adminRoute, schema: { response: { 200: invoiceResponseSchema } } },
    async (request) => {
      const { invoiceId } = InvoiceParamsSchema.parse(request.params);
      ActorBodySchema.parse(request.body ?? {});
      return serializeInvoice(await issueBillingInvoice({ invoiceId, actor: actor(request) }));
    },
  );

  app.get('/internal/admin/billing/invoices/:invoiceId/pdf', adminRoute, async (request, reply) => {
    const { invoiceId } = InvoiceParamsSchema.parse(request.params);
    const pdf = await readBillingInvoicePdf(invoiceId);
    const filename = pdf.filename.replace(/[^A-Za-z0-9_.-]/g, '_');
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .type('application/pdf')
      .send(pdf.value);
  });

  app.post(
    '/internal/admin/billing/invoices/:invoiceId/void',
    { ...adminRoute, schema: { response: { 200: invoiceResponseSchema } } },
    async (request) => {
      const { invoiceId } = InvoiceParamsSchema.parse(request.params);
      const body = z
        .object({ reason: z.string().trim().min(1).max(500) })
        .strict()
        .parse(request.body);
      return serializeInvoice(
        await voidBillingInvoice({ invoiceId, reason: body.reason, actor: actor(request) }),
      );
    },
  );

  app.post(
    '/internal/admin/billing/invoices/:invoiceId/payments',
    { ...adminRoute, schema: { response: { 201: invoiceResponseSchema } } },
    async (request, reply) => {
      const { invoiceId } = InvoiceParamsSchema.parse(request.params);
      const body = z
        .object({
          kind: z.enum(['payment', 'refund', 'write_off']),
          amount_minor: z.string().regex(/^[1-9]\d*$/),
          currency: CurrencySchema,
          idempotency_key: z.string().trim().min(1).max(200),
          reference: z.string().trim().min(1).max(255).nullable().optional(),
          occurred_at: z.string().datetime(),
        })
        .strict()
        .parse(request.body);
      const invoice = await recordBillingInvoicePayment({
        invoiceId,
        kind: body.kind,
        amountMinor: body.amount_minor,
        currency: body.currency,
        idempotencyKey: body.idempotency_key,
        reference: body.reference,
        occurredAt: new Date(body.occurred_at),
        actor: actor(request),
      });
      return reply.status(201).send(await serializeInvoice(invoice));
    },
  );
}
