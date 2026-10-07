import { BillingCreditInvoiceTaxTreatment } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requireAdminSuperuser } from '../../../middleware/admin-superuser.js';
import {
  appendCreditInvoiceTaxPolicy,
  listCreditInvoiceTaxPolicies,
} from '../../../services/billing-credit-invoice-tax-policy.service.js';
import { AppError } from '../../../utils/errors.js';

const PolicyBody = z.object({
  account_id: z.string().min(1),
  issuer_profile_id: z.string().min(1),
  jurisdiction_country: z.string().regex(/^[A-Z]{2}$/),
  treatment: z.nativeEnum(BillingCreditInvoiceTaxTreatment),
  rate_bps: z.number().int().min(0).max(10_000),
  legal_basis_reference: z.string().trim().min(8).max(500),
  effective_from: z.string().datetime({ offset: true }),
}).strict();

function serializePolicy(policy: Awaited<ReturnType<typeof appendCreditInvoiceTaxPolicy>>) {
  return {
    id: policy.id,
    account_id: policy.accountId,
    version: policy.version,
    issuer_profile_id: policy.issuerProfileId,
    jurisdiction_country: policy.jurisdictionCountry,
    treatment: policy.treatment,
    rate_bps: policy.rateBps,
    legal_basis_reference: policy.legalBasisReference,
    effective_from: policy.effectiveFrom.toISOString(),
    created_at: policy.createdAt.toISOString(),
    created_by_email: policy.createdByEmail,
  };
}

export function registerInternalAdminBillingCreditInvoiceTaxPolicyRoutes(app: FastifyInstance) {
  app.get('/internal/admin/billing/credit-invoice-tax-policies', {
    preHandler: [requireAdminSuperuser],
  }, async (_request, reply) => {
    const result = await listCreditInvoiceTaxPolicies();
    return reply.header('Cache-Control', 'private, no-store').send({
      accounts: result.accounts.map((account) => ({
        id: account.id,
        stripe_account_id: account.stripeAccountId,
        livemode: account.livemode,
      })),
      policies: result.policies.map(serializePolicy),
    });
  });

  app.post('/internal/admin/billing/credit-invoice-tax-policies', {
    preHandler: [requireAdminSuperuser],
  }, async (request, reply) => {
    const body = PolicyBody.parse(request.body);
    const claims = request.adminAccessTokenClaims;
    if (!claims) throw new AppError('UNAUTHORIZED', 401, 'MISSING_ACCESS_TOKEN');
    const policy = await appendCreditInvoiceTaxPolicy({
      accountId: body.account_id,
      issuerProfileId: body.issuer_profile_id,
      jurisdictionCountry: body.jurisdiction_country,
      treatment: body.treatment,
      rateBps: body.rate_bps,
      legalBasisReference: body.legal_basis_reference,
      effectiveFrom: new Date(body.effective_from),
      actor: {
        userId: claims.userId,
        tokenVersion: claims.tokenVersion,
        email: claims.email,
      },
    });
    return reply.status(201).header('Cache-Control', 'private, no-store')
      .send(serializePolicy(policy));
  });
}
