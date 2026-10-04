import {
  BillingCreditInvoiceTaxTreatment,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  lockBillingAdminEffectAuthority,
  type BillingAdminEffectActor,
} from './billing-admin-effect-authority.service.js';

type PolicyWrite = {
  accountId: string;
  issuerProfileId: string;
  jurisdictionCountry: string;
  treatment: BillingCreditInvoiceTaxTreatment;
  rateBps: number;
  legalBasisReference: string;
  effectiveFrom: Date;
  actor: BillingAdminEffectActor;
};

export async function listCreditInvoiceTaxPolicies(
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const [accounts, policies] = await Promise.all([
    prisma.billingStripeAccount.findMany({
      select: { id: true, stripeAccountId: true, livemode: true },
      orderBy: [{ livemode: 'desc' }, { stripeAccountId: 'asc' }],
    }),
    prisma.billingCreditInvoiceTaxPolicy.findMany({
      orderBy: [{ accountId: 'asc' }, { version: 'desc' }],
      include: { issuerProfile: { select: { legalName: true } } },
    }),
  ]);
  return { accounts, policies };
}

export async function appendCreditInvoiceTaxPolicy(
  params: PolicyWrite,
  deps?: {
    prisma?: PrismaClient;
    authorize?: typeof lockBillingAdminEffectAuthority;
  },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const country = params.jurisdictionCountry.trim().toUpperCase();
  const basis = params.legalBasisReference.trim();
  if (
    !/^[A-Z]{2}$/.test(country) ||
    basis.length < 8 || basis.length > 500 ||
    !Number.isSafeInteger(params.rateBps) ||
    (params.treatment === BillingCreditInvoiceTaxTreatment.NO_TAX_CHARGED
      ? params.rateBps !== 0
      : params.treatment !== BillingCreditInvoiceTaxTreatment.INCLUSIVE_RATE ||
        params.rateBps < 1 || params.rateBps > 10_000) ||
    !Number.isFinite(params.effectiveFrom.getTime())
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_CREDIT_INVOICE_TAX_POLICY_INVALID');
  }
  return prisma.$transaction(async (tx) => {
    await (deps?.authorize ?? lockBillingAdminEffectAuthority)(tx, params.actor);
    const accounts = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM billing_stripe_accounts WHERE id = ${params.accountId} FOR UPDATE
    `);
    if (accounts.length !== 1) {
      throw new AppError('NOT_FOUND', 404, 'BILLING_STRIPE_ACCOUNT_NOT_FOUND');
    }
    const issuer = await tx.billingInvoiceIssuerProfile.findUnique({
      where: { id: params.issuerProfileId },
      select: { id: true, active: true, address: true, taxIdentifier: true },
    });
    const address = issuer?.address as Record<string, unknown> | null;
    if (!issuer?.active || typeof address?.country !== 'string' ||
      !/^[A-Z]{2}$/.test(address.country) ||
      (params.treatment === BillingCreditInvoiceTaxTreatment.INCLUSIVE_RATE &&
        !issuer.taxIdentifier)) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_CREDIT_INVOICE_ISSUER_TAX_SCOPE_INVALID');
    }
    const latest = await tx.billingCreditInvoiceTaxPolicy.findFirst({
      where: { accountId: params.accountId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const policy = await tx.billingCreditInvoiceTaxPolicy.create({
      data: {
        accountId: params.accountId,
        version: (latest?.version ?? 0) + 1,
        issuerProfileId: issuer.id,
        jurisdictionCountry: country,
        treatment: params.treatment,
        rateBps: params.rateBps,
        legalBasisReference: basis,
        effectiveFrom: params.effectiveFrom,
        createdByUserId: params.actor.userId as string,
        createdByEmail: params.actor.email.trim().toLowerCase(),
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.credit_invoice_tax_policy_added',
        metadata: {
          policy_id: policy.id, account_id: policy.accountId, version: policy.version,
          issuer_profile_id: policy.issuerProfileId,
          jurisdiction_country: policy.jurisdictionCountry,
          treatment: policy.treatment, rate_bps: policy.rateBps,
          effective_from: policy.effectiveFrom.toISOString(),
          legal_basis_reference: policy.legalBasisReference,
        },
      },
    });
    return policy;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

// `grossMinor` is the actual accepted amount. Tax is included within it; this
// function never creates an additional charge or changes the credited quantity.
export function inclusiveTaxMinor(
  grossMinor: bigint,
  policy: { treatment: BillingCreditInvoiceTaxTreatment; rateBps: number },
): bigint {
  if (grossMinor <= 0n) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYMENT_AMOUNT_INVALID');
  }
  if (policy.treatment === BillingCreditInvoiceTaxTreatment.NO_TAX_CHARGED) {
    if (policy.rateBps !== 0) {
      throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_INVOICE_TAX_POLICY_INVALID');
    }
    return 0n;
  }
  if (policy.treatment !== BillingCreditInvoiceTaxTreatment.INCLUSIVE_RATE ||
    !Number.isSafeInteger(policy.rateBps) || policy.rateBps < 1 || policy.rateBps > 10_000) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_INVOICE_TAX_POLICY_INVALID');
  }
  const rate = BigInt(policy.rateBps);
  return (grossMinor * rate + (10_000n + rate) / 2n) / (10_000n + rate);
}
