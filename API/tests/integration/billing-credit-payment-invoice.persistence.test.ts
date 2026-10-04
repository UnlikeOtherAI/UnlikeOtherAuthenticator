import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BillingAssignmentScope,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  BillingCreditInvoiceTaxTreatment,
  BillingCreditPaymentInvoiceState,
  BillingCreditAutoTopUpConsentSource,
  BillingCreditAutoTopUpState,
  MembershipStatus,
  type PrismaClient,
} from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { recordAcceptedCreditPaymentInvoice } from '../../src/services/billing-credit-payment-invoice-source.service.js';
import { appendCreditInvoiceTaxPolicy } from '../../src/services/billing-credit-invoice-tax-policy.service.js';
import { issueCreditPaymentInvoice } from '../../src/services/billing-credit-payment-invoice-issue.service.js';
import type { BillingInvoicePdfStorage } from '../../src/services/billing-invoice-storage.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  fundingRaceIds as ids,
  seedFundingRace,
  stripeAccount,
} from './billing-credit-funding-actions.persistence.fixture.js';

const paidAt = new Date('2026-08-31T23:59:58.000Z');
const issuedAt = new Date('2026-09-01T09:00:00.000Z');
const prefix = randomUUID().slice(0, 8);
const manualId = `topup_invoice_${prefix}`;
const autoIds = [`auto_invoice_a_${prefix}`, `auto_invoice_b_${prefix}`];
const second = {
  team: `team_invoice_${prefix}`,
  customer: `customer_invoice_${prefix}`,
  account: `credit_account_invoice_${prefix}`,
  consent: `consent_invoice_${prefix}`,
};

describe.skipIf(!process.env.DATABASE_URL)('prepaid payment invoice PostgreSQL source', () => {
  let handle: Awaited<ReturnType<typeof createTestDb>>;
  const stored = new Map<string, Uint8Array>();
  const storage: BillingInvoicePdfStorage = {
    putImmutable: vi.fn(async (key, bytes) => {
      if (stored.has(key)) {
        const error = new Error('BILLING_INVOICE_PDF_ALREADY_EXISTS');
        Object.assign(error, { code: 'BAD_REQUEST', statusCode: 409 });
        throw error;
      }
      stored.set(key, bytes);
    }),
    read: vi.fn(async (key) => Buffer.from(stored.get(key) ?? [])),
  };

  async function createCreditEntry(
    prisma: PrismaClient,
    id: string,
    kind: BillingCreditEntryKind,
    at: Date,
    creditAccountId: string,
  ) {
    // Source-lineage fixture only: the production webhook has its own trigger
    // proof. Isolate the new payment-invoice uniqueness/immutability guards.
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const entry = await tx.billingCreditEntry.create({
        data: {
        id,
        creditAccountId,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        attributedUserId: ids.user,
        direction: BillingCreditEntryDirection.CREDIT,
        kind,
        amountMicrocredits: 5_000_000_000n,
        balanceAfterMicrocredits: 5_000_000_000n,
        currency: 'USD',
        idempotencyKey: id,
        sourceType: kind === BillingCreditEntryKind.TOP_UP
          ? 'stripe_top_up' : 'stripe_auto_top_up',
        sourceId: id,
        occurredAt: at,
        },
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      return entry;
    });
  }

  async function record(
    prisma: PrismaClient,
    source: {
      kind: 'top_up' | 'automatic_top_up';
      id: string;
      entryId: string;
      creditAccountId: string;
      teamId: string;
      stripeCustomerId: string;
    },
    paymentId: string,
    paymentDate: Date,
  ) {
    return prisma.$transaction(async (tx) => recordAcceptedCreditPaymentInvoice(tx, {
      account: stripeAccount,
      event: {
        kind: 'payment_succeeded',
        localType: source.kind,
        localId: source.id,
        paymentIntent: {
          id: paymentId,
          status: 'succeeded',
          livemode: false,
          amount_received: 500,
          currency: 'usd',
          customer: source.stripeCustomerId,
          latest_charge: `ch_${paymentId}`,
        } as never,
        chargeId: `ch_${paymentId}`,
        paymentMethodId: 'pm_funding_race',
        checkoutSessionId: null,
        occurredAt: paymentDate,
      },
      source: {
        kind: source.kind,
        id: source.id,
        creditEntryId: source.entryId,
        creditAccountId: source.creditAccountId,
        creditAccountOrgId: ids.org,
        creditAccountTeamId: source.teamId,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        attributedUserId: ids.user,
        amountMinor: 500n,
        creditsMicrocredits: 5_000_000_000n,
        currency: 'USD',
        stripeCustomerId: source.stripeCustomerId,
      },
    }));
  }

  beforeAll(async () => {
    handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL required');
    await seedFundingRace(handle.prisma);
    await handle.prisma.billingCreditTopUpCheckout.create({
      data: {
        id: manualId,
        accountId: ids.account,
        creditAccountId: ids.creditAccount,
        customerId: ids.customer,
        catalogId: ids.catalog,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        offerId: ids.offer,
        actorJti: manualId,
        requestedByUserId: ids.user,
        paymentAmountMinor: 500n,
        creditsReceivedMicrocredits: 5_000_000_000n,
        currency: 'USD',
        successUrlDigest: 'a'.repeat(64),
        cancelUrlDigest: 'b'.repeat(64),
        leaseExpiresAt: new Date('2026-09-02T00:00:00.000Z'),
      },
    });
    await handle.prisma.team.create({
      data: {
        id: second.team, orgId: ids.org,
        name: 'Second funding team', slug: `second-${prefix}`,
      },
    });
    await handle.prisma.teamMember.create({
      data: {
        id: `member_invoice_${prefix}`,
        teamId: second.team,
        userId: ids.user,
        teamRole: 'owner',
        status: MembershipStatus.ACTIVE,
      },
    });
    await handle.prisma.billingStripeCustomer.create({
      data: {
        id: second.customer,
        accountId: ids.account,
        orgId: ids.org,
        teamId: second.team,
        scope: BillingAssignmentScope.TEAM,
        scopeKey: `${ids.org}:${second.team}`,
        stripeCustomerId: `cus_invoice_${prefix}`,
      },
    });
    await handle.prisma.billingCreditAccount.create({
      data: {
        id: second.account,
        accountId: ids.account,
        customerId: second.customer,
        orgId: ids.org,
        teamId: second.team,
        scopeKey: `${ids.org}:${second.team}`,
      },
    });
    // The funding fixture seeds a pre-existing verified consent. This isolated
    // schema-local setup matches that precedent; invoice source writes below
    // run with all production triggers enabled.
    await handle.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.billingCreditAutoTopUpConsentRevision.create({
      data: {
        id: second.consent,
        accountId: ids.account,
        creditAccountId: second.account,
        orgId: ids.org,
        teamId: second.team,
        serviceId: ids.service,
        appKeyId: ids.appKey,
        policyId: ids.policy,
        optionId: ids.option,
        refillOfferId: ids.offer,
        source: BillingCreditAutoTopUpConsentSource.CUSTOMER_UPDATE,
        actorJti: `actor-${prefix}`,
        consentedByUserId: ids.user,
        consentVersion: 'auto-v1',
        thresholdMicrocredits: 200_000_000n,
        refillCreditsMicrocredits: 5_000_000_000n,
        refillPaymentAmountMinor: 500n,
        monthlyChargeCapMinor: 1_500n,
        stripePaymentMethodId: `pm_invoice_${prefix}`,
        paymentMethodSummary: { type: 'card', brand: 'visa', last4: '4242' },
        consentedAt: paidAt,
      },
      });
      await tx.billingCreditAccount.update({
      where: { id: second.account },
      data: {
        autoTopUpState: BillingCreditAutoTopUpState.ACTIVE,
        autoTopUpPolicyId: ids.policy,
        autoTopUpServiceId: ids.service,
        autoTopUpAppKeyId: ids.appKey,
        autoTopUpConsentRevisionId: second.consent,
        autoTopUpOptionId: ids.option,
        autoTopUpThresholdMicrocredits: 200_000_000n,
        autoTopUpRefillOfferId: ids.offer,
        autoTopUpMonthlyChargeCapMinor: 1_500n,
        autoTopUpConsentVersion: 'auto-v1',
        autoTopUpConsentedAt: paidAt,
        autoTopUpConsentedByUserId: ids.user,
        stripePaymentMethodId: `pm_invoice_${prefix}`,
        paymentMethodSummary: { type: 'card', brand: 'visa', last4: '4242' },
      },
      });
    });
    for (const id of autoIds) {
      const isSecond = id === autoIds[1];
      await handle.prisma.billingCreditAutoTopUpAttempt.create({
        data: {
          id,
          accountId: ids.account,
          creditAccountId: isSecond ? second.account : ids.creditAccount,
          catalogId: ids.catalog,
          serviceId: ids.service,
          appKeyId: ids.appKey,
          attributedUserId: ids.user,
          optionId: ids.option,
          offerId: ids.offer,
          consentRevisionId: isSecond ? second.consent : ids.originalConsent,
          consentVersion: 'auto-v1',
          thresholdMicrocredits: 200_000_000n,
          monthlyChargeCapMinor: 1_500n,
          chargedThisMonthBeforeMinor: 0n,
          observedBalanceMicrocredits: 0n,
          paymentAmountMinor: 500n,
          creditsReceivedMicrocredits: 5_000_000_000n,
          billingMonth: '2026-09',
          idempotencyKey: id,
        },
      });
    }
    await handle.prisma.billingInvoiceIssuerProfile.create({
      data: {
        id: `issuer_${prefix}`,
        key: `prepaid-${prefix}`,
        legalName: 'Example Billing Limited',
        billingEmail: 'billing@example.test',
        address: {
          line1: '1 Example Street', city: 'London', postal_code: 'EC1A 1AA',
          country: 'GB',
        },
        taxIdentifier: 'GB123456789',
        invoiceNumberPrefix: `PRE${prefix.toUpperCase()}`,
      },
    });
    await handle.prisma.billingOrganisationInvoiceProfile.create({
      data: {
        id: `buyer_${prefix}`,
        orgId: ids.org,
        legalName: 'Funding Race Org',
        billingEmail: 'accounts@funding-race.example',
        billingAddress: {
          line1: '2 Customer Road', city: 'London', postal_code: 'EC2A 2BB',
          country: 'GB',
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('persists one immutable source per accepted payment despite replay and month rollover', async () => {
    const sources = [
      {
        kind: 'top_up' as const, id: manualId, entryId: `entry_m_${prefix}`,
        creditAccountId: ids.creditAccount, teamId: ids.team,
        stripeCustomerId: 'cus_funding_race',
      },
      ...autoIds.map((id, index) => ({
        kind: 'automatic_top_up' as const, id, entryId: `entry_a${index}_${prefix}`,
        creditAccountId: index === 0 ? ids.creditAccount : second.account,
        teamId: index === 0 ? ids.team : second.team,
        stripeCustomerId: index === 0 ? 'cus_funding_race' : `cus_invoice_${prefix}`,
      })),
    ];
    for (const source of sources) {
      await createCreditEntry(
        handle!.prisma, source.entryId,
        source.kind === 'top_up'
          ? BillingCreditEntryKind.TOP_UP : BillingCreditEntryKind.AUTOMATIC_TOP_UP,
        paidAt, source.creditAccountId,
      );
      await record(handle!.prisma, source, `pi_${source.id}`, paidAt);
      await record(handle!.prisma, source, `pi_${source.id}`, issuedAt);
    }
    const invoices = await handle!.prisma.billingCreditPaymentInvoice.findMany({
      where: { accountId: ids.account },
      orderBy: { id: 'asc' },
    });
    expect(invoices).toHaveLength(3);
    expect(new Set(invoices.map((row) => row.stripePaymentIntentId)).size).toBe(3);
    expect(invoices.map((row) => row.paidAt.toISOString())).toEqual([
      paidAt.toISOString(), paidAt.toISOString(), paidAt.toISOString(),
    ]);
    expect(invoices.every((row) => row.state === BillingCreditPaymentInvoiceState.PENDING))
      .toBe(true);
    const attempts = await handle!.prisma.billingCreditAutoTopUpAttempt.findMany({
      where: { id: { in: autoIds } },
    });
    expect(attempts.every((attempt) => attempt.currency === 'USD')).toBe(true);
    await expect(handle!.prisma.billingCreditAutoTopUpAttempt.update({
      where: { id: autoIds[0] }, data: { currency: 'EUR' },
    })).rejects.toBeDefined();
    await expect(handle!.prisma.billingCreditPaymentInvoice.update({
      where: { id: invoices[0]!.id },
      data: { paidAt: issuedAt },
    })).rejects.toBeDefined();
  }, 30_000);

  it('holds without an explicit tax policy, then issues distinct immutable PDFs', async () => {
    const first = await handle!.prisma.billingCreditPaymentInvoice.findFirstOrThrow({
      where: { topUpCheckoutId: manualId },
    });
    const provider = {} as never;
    const resolveProvider = vi.fn().mockResolvedValue(null);
    const held = await issueCreditPaymentInvoice(first.id, {
      prisma: handle!.prisma, storage, provider, resolveProvider,
      now: () => issuedAt,
    });
    expect(held.state).toBe(BillingCreditPaymentInvoiceState.HELD);
    expect(held.taxAmountMinor).toBeNull();
    expect(held.invoiceNumber).toBeNull();
    await handle!.prisma.billingOrganisationInvoiceProfile.update({
      where: { orgId: ids.org },
      data: { billingAddress: {
        line1: '2 Customer Road', city: 'New York', postal_code: '10001', country: 'US',
      } },
    });
    await appendCreditInvoiceTaxPolicy({
      accountId: ids.account,
      issuerProfileId: `issuer_${prefix}`,
      jurisdictionCountry: 'US',
      treatment: BillingCreditInvoiceTaxTreatment.INCLUSIVE_RATE,
      rateBps: 2000,
      legalBasisReference: 'operator-approved US buyer tax treatment',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      actor: { userId: ids.user, email: 'funding-race@example.com', tokenVersion: 0 },
    }, { prisma: handle!.prisma, authorize: vi.fn().mockResolvedValue(undefined) });
    const rows = await handle!.prisma.billingCreditPaymentInvoice.findMany({
      where: { accountId: ids.account },
    });
    resolveProvider.mockImplementation(async (source: { id: string }) =>
      source.id === first.id ? {
        invoiceId: `in_${prefix}`,
        number: `STRIPE-${prefix}`,
        issuedAt,
        taxMinor: 83n,
        accountName: 'Example Billing Limited', accountCountry: 'GB',
        buyerName: 'Funding Race Org', buyerEmail: 'accounts@funding-race.example',
        buyerCountry: 'US',
        buyerAddress: { line1: '2 Customer Road', city: 'New York', postal_code: '10001' },
        pdf: new TextEncoder().encode('%PDF-1.7 verified-provider-fixture'),
      } : null);
    const issued = await Promise.all(rows.map((row) => issueCreditPaymentInvoice(row.id, {
      prisma: handle!.prisma, storage, provider, resolveProvider,
      now: () => issuedAt,
    })));
    expect(issued.every((row) => row.state === BillingCreditPaymentInvoiceState.ISSUED))
      .toBe(true);
    expect(new Set(issued.map((row) => row.invoiceNumber)).size).toBe(3);
    expect(issued.every((row) => row.taxAmountMinor === 83n)).toBe(true);
    expect(issued.some((row) => row.stripeInvoiceId === `in_${prefix}`)).toBe(true);
    expect(issued.some((row) => row.taxPolicyId && !row.stripeInvoiceId)).toBe(true);
    expect(issued.every((row) => row.pdfSha256 && row.pdfObjectKey)).toBe(true);
    expect(stored.size).toBe(3);
    const proofDir = process.env.BILLING_COLLECTION_PROOF_DIR;
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
      await writeFile(path.join(proofDir, 'prepaid-payment-invoice.pdf'),
        stored.get(issued.find((row) => !row.stripeInvoiceId)!.pdfObjectKey!)!);
    }
    await expect(handle!.prisma.billingCreditPaymentInvoice.update({
      where: { id: issued[0]!.id },
      data: { taxAmountMinor: 0n },
    })).rejects.toBeDefined();
    await expect(handle!.prisma.billingCreditPaymentInvoice.delete({
      where: { id: issued[0]!.id },
    })).rejects.toBeDefined();
  }, 30_000);
});
