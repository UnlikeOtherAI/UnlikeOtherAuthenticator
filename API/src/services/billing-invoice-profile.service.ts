import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

export type BillingPostalAddress = {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postal_code: string;
  country: string;
};

type Actor = { email: string };

function client(deps?: { prisma?: PrismaClient }): PrismaClient {
  return deps?.prisma ?? getAdminPrisma();
}

function clean(value: string, max: number, code = 'BILLING_INVOICE_PROFILE_INVALID'): string {
  const result = value.trim();
  if (!result || result.length > max) throw new AppError('BAD_REQUEST', 400, code);
  return result;
}

function optional(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return clean(value, max);
}

function address(value: BillingPostalAddress): BillingPostalAddress {
  const line2 = optional(value.line2, 200);
  const region = optional(value.region, 120);
  const normalized = {
    line1: clean(value.line1, 200),
    ...(line2 ? { line2 } : {}),
    city: clean(value.city, 120),
    ...(region ? { region } : {}),
    postal_code: clean(value.postal_code, 32),
    country: value.country.trim().toUpperCase(),
  };
  if (!/^[A-Z]{2}$/.test(normalized.country)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_PROFILE_INVALID');
  }
  return normalized;
}

export async function listBillingInvoiceIssuerProfiles(deps?: { prisma?: PrismaClient }) {
  return client(deps).billingInvoiceIssuerProfile.findMany({
    orderBy: [{ active: 'desc' }, { key: 'asc' }],
  });
}

export async function getOrganisationInvoiceProfile(
  organisationId: string,
  deps?: { prisma?: PrismaClient },
) {
  const profile = await client(deps).billingOrganisationInvoiceProfile.findUnique({
    where: { orgId: organisationId },
  });
  if (!profile) {
    throw new AppError('NOT_FOUND', 404, 'BILLING_INVOICE_BUYER_PROFILE_NOT_FOUND');
  }
  return profile;
}

export async function createBillingInvoiceIssuerProfile(
  params: {
    key: string;
    legalName: string;
    tradingName?: string | null;
    billingEmail: string;
    address: BillingPostalAddress;
    taxIdentifier?: string | null;
    companyRegistrationNumber?: string | null;
    invoiceNumberPrefix: string;
    actor: Actor;
  },
  deps?: { prisma?: PrismaClient },
) {
  const key = clean(params.key.toLowerCase(), 80);
  const billingEmail = clean(params.billingEmail.toLowerCase(), 254);
  const prefix = clean(params.invoiceNumberPrefix.toUpperCase(), 32);
  if (
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail) ||
    !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(prefix)
  ) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_PROFILE_INVALID');
  }
  return client(deps).$transaction(async (tx) => {
    const profile = await tx.billingInvoiceIssuerProfile.create({
      data: {
        key,
        legalName: clean(params.legalName, 200),
        tradingName: optional(params.tradingName, 200),
        billingEmail,
        address: address(params.address),
        taxIdentifier: optional(params.taxIdentifier, 100),
        companyRegistrationNumber: optional(params.companyRegistrationNumber, 100),
        invoiceNumberPrefix: prefix,
      },
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.invoice_issuer_profile_created',
        metadata: { issuer_profile_id: profile.id, key: profile.key },
      },
    });
    return profile;
  });
}

export async function upsertOrganisationInvoiceProfile(
  params: {
    organisationId: string;
    legalName: string;
    billingEmail: string;
    billingAddress: BillingPostalAddress;
    taxIdentifier?: string | null;
    purchaseOrderReference?: string | null;
    actor: Actor;
  },
  deps?: { prisma?: PrismaClient },
) {
  const billingEmail = clean(params.billingEmail.toLowerCase(), 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_PROFILE_INVALID');
  }
  const prisma = client(deps);
  return prisma.$transaction(async (tx) => {
    const org = await tx.organisation.findUnique({
      where: { id: params.organisationId },
      select: { id: true },
    });
    if (!org) throw new AppError('NOT_FOUND', 404, 'ORGANISATION_NOT_FOUND');
    const values = {
      legalName: clean(params.legalName, 200),
      billingEmail,
      billingAddress: address(params.billingAddress),
      taxIdentifier: optional(params.taxIdentifier, 100),
      purchaseOrderReference: optional(params.purchaseOrderReference, 120),
    };
    const profile = await tx.billingOrganisationInvoiceProfile.upsert({
      where: { orgId: org.id },
      create: { orgId: org.id, ...values },
      update: values,
    });
    await tx.adminAuditLog.create({
      data: {
        actorEmail: params.actor.email,
        action: 'billing.organisation_invoice_profile_upserted',
        metadata: { organisation_id: org.id, buyer_profile_id: profile.id },
      },
    });
    return profile;
  });
}
