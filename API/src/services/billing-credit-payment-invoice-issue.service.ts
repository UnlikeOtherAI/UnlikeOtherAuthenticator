import { createHash } from 'node:crypto';

import {
  BillingCreditPaymentInvoiceState,
  BillingCreditPaymentInvoiceTaxSource,
  Prisma,
  type BillingCreditPaymentInvoice,
  type PrismaClient,
} from '@prisma/client';
import type Stripe from 'stripe';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { inclusiveTaxMinor } from './billing-credit-invoice-tax-policy.service.js';
import {
  generateCreditPaymentInvoicePdf,
  type PaymentInvoicePdfInput,
} from './billing-credit-payment-invoice-pdf.service.js';
import {
  resolveExistingStripePaymentInvoice,
  type VerifiedStripePaymentInvoice,
} from './billing-credit-payment-stripe-invoice.service.js';
import {
  createBillingInvoicePdfStorage,
  type BillingInvoicePdfStorage,
} from './billing-invoice-storage.service.js';

type Provider = Pick<Stripe, 'checkout' | 'invoicePayments' | 'invoices'>;
type IssueDeps = {
  prisma?: PrismaClient;
  storage?: BillingInvoicePdfStorage;
  provider: Provider;
  resolveProvider?: typeof resolveExistingStripePaymentInvoice;
  generatePdf?: typeof generateCreditPaymentInvoicePdf;
  now?: () => Date;
};
type Snapshot = Record<string, unknown>;

async function retryIssueClaim<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? error.code : null;
      if ((code !== 'P2034' && code !== 'P2002') || attempt === 3) throw error;
    }
  }
  throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_INVOICE_ISSUE_BUSY');
}

function object(value: Prisma.JsonValue): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function country(value: Prisma.JsonValue): string | null {
  const item = object(value);
  const countryValue = item?.country;
  return typeof countryValue === 'string' && /^[A-Z]{2}$/.test(countryValue)
    ? countryValue : null;
}

function issuerSnapshot(value: {
  id: string; legalName: string; tradingName: string | null;
  billingEmail: string; address: Prisma.JsonValue;
  taxIdentifier: string | null; companyRegistrationNumber: string | null;
}): Snapshot {
  return {
    profile_id: value.id,
    legal_name: value.legalName,
    trading_name: value.tradingName,
    billing_email: value.billingEmail,
    address: value.address,
    tax_identifier: value.taxIdentifier,
    company_registration_number: value.companyRegistrationNumber,
  };
}

function buyerSnapshot(value: {
  id: string; legalName: string; billingEmail: string;
  billingAddress: Prisma.JsonValue; taxIdentifier: string | null;
  purchaseOrderReference: string | null;
}): Snapshot {
  return {
    profile_id: value.id,
    legal_name: value.legalName,
    billing_email: value.billingEmail,
    billing_address: value.billingAddress,
    tax_identifier: value.taxIdentifier,
    purchase_order_reference: value.purchaseOrderReference,
  };
}

function verifiedProviderMatches(
  value: VerifiedStripePaymentInvoice,
  issuer: { legalName: string; address: Prisma.JsonValue },
  buyer: { legalName: string; billingEmail: string; billingAddress: Prisma.JsonValue },
): boolean {
  const address = object(buyer.billingAddress);
  return value.accountName.trim() === issuer.legalName.trim() &&
    value.accountCountry.toUpperCase() === country(issuer.address) &&
    value.buyerName.trim() === buyer.legalName.trim() &&
    value.buyerEmail.trim().toLowerCase() === buyer.billingEmail.trim().toLowerCase() &&
    value.buyerCountry.toUpperCase() === country(buyer.billingAddress) &&
    value.buyerAddress.line1 === address?.line1 &&
    value.buyerAddress.city === address?.city &&
    value.buyerAddress.postal_code === address?.postal_code;
}

async function markHeld(prisma: PrismaClient, id: string, reason: string) {
  await prisma.billingCreditPaymentInvoice.updateMany({
    where: {
      id,
      state: { in: [
        BillingCreditPaymentInvoiceState.PENDING,
        BillingCreditPaymentInvoiceState.HELD,
      ] },
    },
    data: { state: BillingCreditPaymentInvoiceState.HELD, holdReason: reason },
  });
  return prisma.billingCreditPaymentInvoice.findUniqueOrThrow({ where: { id } });
}

async function freezeIssueFacts(
  prisma: PrismaClient,
  sourceId: string,
  providerInvoice: VerifiedStripePaymentInvoice | null,
  now: Date,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM billing_credit_payment_invoices WHERE id = ${sourceId} FOR UPDATE
    `);
    const source = await tx.billingCreditPaymentInvoice.findUniqueOrThrow({
      where: { id: sourceId },
    });
    if (source.state === BillingCreditPaymentInvoiceState.ISSUED ||
        source.state === BillingCreditPaymentInvoiceState.ISSUING) return source;
    const buyer = await tx.billingOrganisationInvoiceProfile.findUnique({
      where: { orgId: source.orgId },
    });
    const buyerCountry = buyer ? country(buyer.billingAddress) : null;
    if (!buyer || !buyerCountry) {
      return { hold: 'BILLING_CREDIT_INVOICE_BUYER_MISSING' } as const;
    }
    const policy = providerInvoice ? null : await tx.billingCreditInvoiceTaxPolicy.findFirst({
      where: {
        accountId: source.accountId,
        jurisdictionCountry: buyerCountry,
        effectiveFrom: { lte: source.paidAt },
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      include: { issuerProfile: true },
    });
    if (!providerInvoice && !policy) {
      return { hold: 'BILLING_CREDIT_INVOICE_TAX_POLICY_MISSING' } as const;
    }
    const issuer = providerInvoice
      ? await tx.billingInvoiceIssuerProfile.findFirst({
        where: { active: true, legalName: providerInvoice.accountName },
      })
      : policy?.issuerProfile;
    if (!issuer?.active || !country(issuer.address)) {
      return { hold: 'BILLING_CREDIT_INVOICE_ISSUER_MISSING' } as const;
    }
    if (providerInvoice && !verifiedProviderMatches(providerInvoice, issuer, buyer)) {
      return { hold: 'BILLING_CREDIT_INVOICE_STRIPE_PARTIES_MISMATCH' } as const;
    }
    const issueTime = providerInvoice?.issuedAt ?? now;
    if (!Number.isFinite(issueTime.getTime())) {
      return { hold: 'BILLING_CREDIT_INVOICE_ISSUE_TIME_INVALID' } as const;
    }
    let invoiceNumber = providerInvoice?.number;
    if (!invoiceNumber) {
      const sequence = await tx.billingInvoiceNumberSequence.upsert({
        where: {
          issuerProfileId_year: {
            issuerProfileId: issuer.id,
            year: issueTime.getUTCFullYear(),
          },
        },
        create: {
          issuerProfileId: issuer.id,
          year: issueTime.getUTCFullYear(),
          lastValue: 1n,
        },
        update: { lastValue: { increment: 1n } },
      });
      invoiceNumber = `${issuer.invoiceNumberPrefix}-${issueTime.getUTCFullYear()}-${sequence.lastValue.toString().padStart(6, '0')}`;
    }
    const taxEvidence = providerInvoice ? {
      minor: providerInvoice.taxMinor,
      source: BillingCreditPaymentInvoiceTaxSource.STRIPE_INVOICE,
      reference: providerInvoice.invoiceId,
      policyId: null,
    } : policy ? {
      minor: inclusiveTaxMinor(source.grossAmountMinor, policy),
      source: BillingCreditPaymentInvoiceTaxSource.ISSUER_POLICY,
      reference: policy.id,
      policyId: policy.id,
    } : null;
    if (!taxEvidence) {
      return { hold: 'BILLING_CREDIT_INVOICE_TAX_POLICY_MISSING' } as const;
    }
    const updated = await tx.billingCreditPaymentInvoice.update({
      where: { id: source.id },
      data: {
        state: BillingCreditPaymentInvoiceState.ISSUING,
        holdReason: null,
        stripeInvoiceId: providerInvoice?.invoiceId ?? null,
        taxAmountMinor: taxEvidence.minor,
        taxSource: taxEvidence.source,
        taxEvidenceReference: taxEvidence.reference,
        taxPolicyId: taxEvidence.policyId,
        issuerProfileId: issuer.id,
        buyerProfileId: buyer.id,
        issuerSnapshot: issuerSnapshot(issuer) as Prisma.InputJsonValue,
        buyerSnapshot: buyerSnapshot(buyer) as Prisma.InputJsonValue,
        invoiceNumber,
        issuedAt: issueTime,
      },
    });
    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

function pdfInput(source: BillingCreditPaymentInvoice): PaymentInvoicePdfInput {
  const issuer = source.issuerSnapshot ? object(source.issuerSnapshot) : null;
  const buyer = source.buyerSnapshot ? object(source.buyerSnapshot) : null;
  if (!issuer || !buyer || !source.invoiceNumber || !source.issuedAt ||
      source.taxAmountMinor === null) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_INVOICE_FACTS_INCOMPLETE');
  }
  return {
    number: source.invoiceNumber,
    issuedAt: source.issuedAt,
    paidAt: source.paidAt,
    currency: source.currency,
    grossMinor: source.grossAmountMinor,
    taxMinor: source.taxAmountMinor,
    issuerSnapshot: issuer,
    buyerSnapshot: buyer,
  };
}

async function putVerified(storage: BillingInvoicePdfStorage, key: string, value: Uint8Array) {
  const expected = createHash('sha256').update(value).digest('hex');
  try {
    await storage.putImmutable(key, value);
  } catch (error) {
    if (!(error instanceof AppError) || error.message !== 'BILLING_INVOICE_PDF_ALREADY_EXISTS') {
      throw error;
    }
    const previous = await storage.read(key);
    if (createHash('sha256').update(previous).digest('hex') !== expected) {
      throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_INVOICE_PDF_IMMUTABILITY_CONFLICT');
    }
  }
  return expected;
}

export async function issueCreditPaymentInvoice(sourceId: string, deps: IssueDeps) {
  const prisma = deps.prisma ?? getAdminPrisma();
  const source = await prisma.billingCreditPaymentInvoice.findUniqueOrThrow({
    where: { id: sourceId },
  });
  if (source.state === BillingCreditPaymentInvoiceState.ISSUED) return source;
  let providerInvoice: VerifiedStripePaymentInvoice | null = null;
  const checkoutSessionId = source.topUpCheckoutId
    ? (await prisma.billingCreditTopUpCheckout.findUnique({
        where: { id: source.topUpCheckoutId },
        select: { stripeCheckoutSessionId: true },
      }))?.stripeCheckoutSessionId
    : null;
  if (source.state !== BillingCreditPaymentInvoiceState.ISSUING) {
    try {
      providerInvoice = await (deps.resolveProvider ??
        resolveExistingStripePaymentInvoice)(source, deps.provider, fetch, checkoutSessionId);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        return markHeld(prisma, sourceId, error.message);
      }
      throw error;
    }
  }
  const frozen = await retryIssueClaim(() => freezeIssueFacts(
    prisma, sourceId, providerInvoice, deps.now?.() ?? new Date(),
  ));
  if ('hold' in frozen) return markHeld(prisma, sourceId, frozen.hold);
  if (frozen.state === BillingCreditPaymentInvoiceState.ISSUED) return frozen;
  if (providerInvoice && providerInvoice.invoiceId !== frozen.stripeInvoiceId) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_CLAIM_MISMATCH');
  }
  const key = `billing-invoices/prepaid/${frozen.orgId}/${frozen.id}.pdf`;
  const pdf = frozen.stripeInvoiceId
    ? providerInvoice?.pdf
    : await (deps.generatePdf ?? generateCreditPaymentInvoicePdf)(pdfInput(frozen));
  if (!pdf) {
    // A process may resume a frozen Stripe claim. Fetch and reverify the same
    // provider invoice before storing bytes, never silently switch issuer.
    const replay = await (deps.resolveProvider ??
      resolveExistingStripePaymentInvoice)(frozen, deps.provider, fetch, checkoutSessionId);
    if (!replay || replay.invoiceId !== frozen.stripeInvoiceId ||
        replay.number !== frozen.invoiceNumber || replay.taxMinor !== frozen.taxAmountMinor ||
        replay.issuedAt.getTime() !== frozen.issuedAt?.getTime()) {
      throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_REPLAY_MISMATCH');
    }
    providerInvoice = replay;
  }
  const verifiedPdf = pdf ?? providerInvoice?.pdf;
  if (!verifiedPdf) {
    throw new AppError('INTERNAL', 409, 'STRIPE_PAYMENT_INVOICE_PDF_MISSING');
  }
  const sha = await putVerified(
    deps.storage ?? createBillingInvoicePdfStorage(), key, verifiedPdf,
  );
  const saved = await prisma.billingCreditPaymentInvoice.updateMany({
    where: { id: frozen.id, state: BillingCreditPaymentInvoiceState.ISSUING },
    data: {
      state: BillingCreditPaymentInvoiceState.ISSUED,
      pdfObjectKey: key,
      pdfSha256: sha,
    },
  });
  const final = await prisma.billingCreditPaymentInvoice.findUniqueOrThrow({
    where: { id: frozen.id },
  });
  if ((saved.count !== 1 && final.state !== BillingCreditPaymentInvoiceState.ISSUED) ||
      final.pdfObjectKey !== key || final.pdfSha256 !== sha) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_INVOICE_ISSUE_CONFLICT');
  }
  return final;
}
