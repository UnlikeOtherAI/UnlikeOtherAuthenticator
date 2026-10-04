import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCreditAccount } from '../../src/services/billing-credit-account.service.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { reconcileStripeUsageExport } from '../../src/services/billing-stripe-reconciliation.service.js';
import { recordStripeInvoiceClose } from '../../src/services/billing-stripe-invoice-close-state.service.js';
import { runStripeInvoiceCloseCycle } from '../../src/services/billing-stripe-invoice-close-scheduler.service.js';
import { compensateFinalizedStripeInvoice } from '../../src/services/billing-stripe-invoice-close-resolution.service.js';
import {
  assertOrgBillingAssumable,
  BillingOrgResponsibilityBlockedError,
} from '../../src/services/billing-org-responsibility-guard.service.js';
import {
  assumeOrgBillingResponsibility,
  releaseOrgBillingResponsibility,
} from '../../src/services/billing-org-responsibility-lifecycle.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  credential, ids, lifecycleDeps, portfolio, request, seed, stripeAccount,
} from './billing-org-responsibility.persistence.fixture.js';

const databaseTestsEnabled =
  process.env.BILLING_FUNDING_DATABASE_TESTS === 'true' && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseTestsEnabled)('organisation billing responsibility persistence', () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const handle = await createTestDb();
    if (!handle) throw new Error('DATABASE_URL is required for organisation billing tests');
    prisma = handle.prisma;
    cleanup = handle.cleanup;
    await seed(prisma);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('resolves the team account while no organisation has taken billing over', async () => {
    const resolved = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );

    expect(resolved.id).toBe(ids.teamCreditAccount);
    expect(resolved.scope).toBe('TEAM');
    expect(resolved.teamId).toBe(ids.teamA);
    expect(resolved.scopeKey).toBe(`${ids.org}:${ids.teamA}`);
  });

  it('refuses to assume while a team funding action is still in flight', async () => {
    // A cancellation preview the customer is still holding: it can be
    // confirmed a second later, against the team's own account.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "billing_cancellation_intents" (
        "id", "token_digest", "app_key_id", "service_id", "org_id", "team_id",
        "requested_by_user_id", "direct_service_ids", "direct_subscription_ids",
        "indirect_service_ids", "entitlement_fingerprint", "subscription_fingerprint",
        "state", "expires_at", "updated_at"
      ) VALUES (
        'bci_org_billing_open', ${'d'.repeat(64)}, ${ids.appKey}, ${ids.service}, ${ids.org},
        ${ids.teamA}, ${ids.owner}, ARRAY[${ids.service}], ARRAY['bss_org_billing_team'],
        ARRAY[]::text[],
        ${'e'.repeat(64)}, ${'f'.repeat(64)}, 'AVAILABLE',
        CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP
      )
    `);

    await expect(
      assertOrgBillingAssumable({ organisationId: ids.org, now: new Date() }, { prisma }),
    ).rejects.toThrow('FUNDING_ACTION_IN_FLIGHT');

    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "billing_cancellation_intents" WHERE "id" = 'bci_org_billing_open'
    `);
  });

  it('refuses to assume while a live team subscription exists, naming it', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_stripe_subscriptions" (
        "id", "account_id", "customer_id", "service_id", "tariff_id", "tariff_source",
        "org_id", "team_id", "scope", "scope_key", "checkout_id", "stripe_subscription_id",
        "stripe_usage_item_id", "status", "livemode", "updated_at"
      ) VALUES (
        'bss_org_billing_team', ${ids.account}, ${ids.teamCustomer}, ${ids.service}, ${ids.tariff},
        'SERVICE_DEFAULT', ${ids.org}, ${ids.teamA}, 'TEAM', ${`${ids.org}:${ids.teamA}`},
        'bsch_org_billing', 'sub_org_billing', 'si_org_billing', 'active', false, CURRENT_TIMESTAMP
      )
      `);
    });

    const error = await assertOrgBillingAssumable(
      { organisationId: ids.org, now: new Date() },
      { prisma },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BillingOrgResponsibilityBlockedError);
    expect((error as BillingOrgResponsibilityBlockedError).reason).toBe(
      'TEAM_SUBSCRIPTIONS_ACTIVE',
    );
    expect((error as BillingOrgResponsibilityBlockedError).subscriptions).toEqual([
      {
        subscriptionId: 'bss_org_billing_team',
        serviceId: ids.service,
        scopeKey: `${ids.org}:${ids.teamA}`,
        status: 'active',
      },
    ]);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_stripe_subscriptions" SET "status" = 'canceled'
        WHERE "id" = 'bss_org_billing_team'
      `);
    });
  });

  it('moves every team onto the organisation account once billing is assumed', async () => {
    const assumed = await assumeOrgBillingResponsibility(
      { request, actorToken: 'signed-actor', credential },
      lifecycleDeps(prisma, new Date('2026-06-01T00:00:00.000Z')),
    );
    expect(assumed).toMatchObject({ organisation_id: ids.org, active: true });

    const fromTeamA = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );
    const fromTeamB = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamB },
      { prisma },
    );

    // Both teams resolve to the one organisation account: this is the whole of
    // the money side. No caller had to change.
    expect(fromTeamA.id).toBe(fromTeamB.id);
    expect(fromTeamA.id).not.toBe(ids.teamCreditAccount);
    expect(fromTeamA.scope).toBe('ORGANISATION');
    expect(fromTeamA.teamId).toBeNull();
    expect(fromTeamA.scopeKey).toBe(ids.org);
    expect(fromTeamA.balanceMicrocredits).toBe(0n);

    // The team's own balance is not swept: it stays exactly where it was.
    const teamAccount = await prisma.billingCreditAccount.findUnique({
      where: { id: ids.teamCreditAccount },
    });
    expect(teamAccount?.balanceMicrocredits).toBe(500000000n);

    const audit = await prisma.orgAuditLog.findFirst({
      where: { orgId: ids.org, action: 'billing.org_responsibility_assumed' },
    });
    expect(audit).not.toBeNull();
  });

  it("settles a team's metered usage against the organisation account", async () => {
    const organisationAccount = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamB },
      { prisma },
    );

    await settleCreditPortfolio(
      {
        creditAccountId: organisationAccount.id,
        portfolio: portfolio(ids.teamB, 'mup_org_billing_team_b'),
        credential,
      },
      { prisma },
    );

    // The snapshot keeps the team it came from, even though the credits are
    // the organisation's.
    const snapshot = await prisma.billingCreditPortfolioSnapshot.findFirst({
      where: { creditAccountId: organisationAccount.id },
    });
    expect(snapshot?.teamId).toBe(ids.teamB);

    // The usage is rated against the organisation account, and attributed to a
    // user who belongs to the team the portfolio came from. Before this change
    // the attribution assert demanded membership of the *account's* team, and
    // an organisation account has none — this row is the proof it now asks the
    // organisation instead.
    const settlement = await prisma.billingCreditUsageSettlement.findFirst({
      where: { creditAccountId: organisationAccount.id, billingMonth: '2026-07' },
      include: { adjustments: { orderBy: { sequence: 'desc' }, take: 1 } },
    });
    expect(settlement).not.toBeNull();
    expect(settlement?.adjustments[0]?.cumulativeRatedUsageAmountMicroMinor).toBeGreaterThan(0n);

    const allocation = await prisma.billingCreditUsageAllocation.findFirst({
      where: { settlementId: settlement?.id ?? '' },
    });
    expect(allocation?.attributedUserId).toBe(ids.member);

    // How much of that rated usage is drawn down is the settlement rules'
    // business (a fresh account holds no credits to draw), and is covered by
    // billing-credit-settlement.persistence.test.ts. What matters here is that
    // the draw is aimed at the organisation's account at all.
  });

  it('returns teams to their own accounts on release, without re-scoping history', async () => {
    const organisationAccount = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );

    const released = await releaseOrgBillingResponsibility(
      { request, actorToken: 'signed-actor', credential },
      lifecycleDeps(prisma),
    );
    expect(released).toMatchObject({ active: false });
    expect(released.released_at).not.toBeNull();

    const resolved = await resolveCreditAccount(
      { account: stripeAccount, organisationId: ids.org, teamId: ids.teamA },
      { prisma },
    );
    expect(resolved.id).toBe(ids.teamCreditAccount);
    expect(resolved.balanceMicrocredits).toBe(500000000n);

    // The organisation account and everything settled against it stay exactly
    // where the spend was incurred.
    const organisationRows = await prisma.billingCreditPortfolioSnapshot.count({
      where: { creditAccountId: organisationAccount.id },
    });
    expect(organisationRows).toBeGreaterThan(0);
  });

  it('records immutable evidence before resolving an expired uncertain Stripe delivery', async () => {
    const row = await prisma.billingStripeUsageExport.create({
      data: {
        id: 'bue_org_billing_uncertain', accountId: ids.account,
        subscriptionId: 'bss_org_billing_team',
        ledgerSnapshotCursor: 'bus_org_billing_uncertain', billingMonth: '2026-07',
        billingProduct: 'deepwater', callerProduct: 'deepwater', currency: 'USD',
        cumulativeCustomerCharge: '1.30', cumulativeMeterQuantity: 130000000n,
        deltaMeterQuantity: 130000000n,
        stripeMeterEventIdentifier: 'uoa_me_org_billing_uncertain',
        stripeMeterEventState: 'RECONCILIATION_REQUIRED',
        stripeMeterEventFirstAttemptedAt: new Date('2026-07-21T12:00:00.000Z'),
        stripeMeterEventAttemptedAt: new Date('2026-07-21T12:00:00.000Z'),
        createdAt: new Date('2026-07-21T11:59:00.000Z'),
      },
    });
    await expect(reconcileStripeUsageExport({
      exportId: row.id, outcome: 'not_accepted',
      evidenceReference: 'Stripe workbench search 2026-10-04 no event',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T10:00:00.000Z'),
      now: new Date('2026-10-04T11:00:00.000Z'),
    }, { prisma })).rejects.toThrow('STRIPE_USAGE_MONTH_OUT_OF_RANGE');
    expect(await prisma.billingStripeUsageReconciliation.count({ where: { exportId: row.id } }))
      .toBe(0);
    await reconcileStripeUsageExport({
      exportId: row.id, outcome: 'manual_invoice',
      evidenceReference: 'in_approved_reconciliation_001',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T10:00:00.000Z'),
      now: new Date('2026-10-04T11:00:00.000Z'),
    }, { prisma });
    const settled = await prisma.billingStripeUsageExport.findUniqueOrThrow({ where: { id: row.id } });
    expect(settled.stripeMeterEventState).toBe('MANUAL_SETTLED');
    const evidence = await prisma.billingStripeUsageReconciliation.findFirstOrThrow({
      where: { exportId: row.id },
    });
    expect(evidence.evidenceReference).toBe('in_approved_reconciliation_001');
    expect(evidence.priorEventIdentifier).toBe('uoa_me_org_billing_uncertain');
    await expect(prisma.billingStripeUsageReconciliation.update({
      where: { id: evidence.id }, data: { evidenceReference: 'altered' },
    })).rejects.toThrow();
    expect(await prisma.adminAuditLog.count({
      where: { action: 'billing.stripe_meter_reconciled' },
    })).toBe(1);

    const retryable = await prisma.billingStripeUsageExport.create({
      data: {
        id: 'bue_org_billing_retryable', accountId: ids.account,
        subscriptionId: 'bss_org_billing_team',
        ledgerSnapshotCursor: 'bus_org_billing_retryable', billingMonth: '2026-10',
        billingProduct: 'deepwater', callerProduct: 'deepwater', currency: 'USD',
        cumulativeCustomerCharge: '0.20', cumulativeMeterQuantity: 20000000n,
        deltaMeterQuantity: 20000000n,
        stripeMeterEventIdentifier: 'uoa_me_org_billing_retryable',
        stripeMeterEventState: 'RECONCILIATION_REQUIRED',
        stripeMeterEventFirstAttemptedAt: new Date('2026-10-04T09:00:00.000Z'),
        stripeMeterEventAttemptedAt: new Date('2026-10-04T09:05:00.000Z'),
        createdAt: new Date('2026-10-04T08:59:00.000Z'),
      },
    });
    await expect(reconcileStripeUsageExport({
      exportId: retryable.id, outcome: 'not_accepted',
      evidenceReference: 'Stripe workbench search confirmed no event',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T09:06:00.000Z'),
      now: new Date('2026-10-04T09:06:00.000Z'),
    }, { prisma })).rejects.toThrow('STRIPE_METER_EVENT_SEND_STILL_ACTIVE');
    await reconcileStripeUsageExport({
      exportId: retryable.id, outcome: 'not_accepted',
      evidenceReference: 'Stripe workbench search confirmed no event',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T10:00:00.000Z'),
      now: new Date('2026-10-04T11:00:00.000Z'),
    }, { prisma });
    const fresh = await prisma.billingStripeUsageExport.findUniqueOrThrow({
      where: { id: retryable.id },
    });
    expect(fresh.stripeMeterEventState).toBe('PENDING');
    expect(fresh.stripeMeterEventFirstAttemptedAt).toBeNull();
    expect(fresh.stripeMeterEventAttemptGeneration).toBe(1);
    expect(fresh.stripeMeterEventIdentifier).toBe('uoa_me_org_billing_retryable_r1');
    expect((await prisma.billingStripeUsageReconciliation.findFirstOrThrow({
      where: { exportId: retryable.id },
    })).priorEventIdentifier).toBe('uoa_me_org_billing_retryable');
  });

  it('persists a finalized late-usage liability until a verified manual invoice compensates it', async () => {
    const observedAt = new Date('2026-10-04T12:00:00.000Z');
    await prisma.billingStripeCustomer.update({
      where: { id: ids.teamCustomer },
      data: { stripeCustomerId: 'cus_org_billing_team' },
    });
    const close = await recordStripeInvoiceClose({
      accountId: ids.account,
      subscriptionId: 'bss_org_billing_team',
      invoiceId: 'in_org_billing_closed',
      billingMonth: '2026-07',
      periodStartsAt: new Date('2026-07-01T00:00:00.000Z'),
      periodEndsAt: new Date('2026-08-01T00:00:00.000Z'),
      currency: 'USD', state: 'FINALIZED_HOLD',
      lastError: 'STRIPE_INVOICE_ALREADY_FINALIZED', now: observedAt,
    }, prisma);
    const invoice = { id: close.stripeInvoiceId, livemode: false, status: 'paid' };
    const cycle = await runStripeInvoiceCloseCycle({
      prisma, now: () => new Date('2026-10-04T13:01:00.000Z'),
      stripe: { invoices: { retrieve: async () => invoice } } as never,
      quote: async () => ({
        ledgerSnapshotCursor: 'bus_late_july_123456789',
        amountMicroMinor: 130_000_000n,
        currency: 'USD',
      }),
    });
    expect(cycle).toEqual({ checked: 1, held: 0, unbilled: 1 });
    const held = await prisma.billingStripeInvoiceClose.findUniqueOrThrow({ where: { id: close.id } });
    expect(held.state).toBe('FINALIZED_HOLD');
    expect(held.unbilledAmountMicroMinor).toBe(130_000_000n);
    const metadata = {
      uoa_source_close_id: close.id,
      uoa_source_invoice_id: close.stripeInvoiceId,
      uoa_source_subscription_id: close.subscriptionId,
      uoa_source_service_id: ids.service,
      uoa_source_billing_month: close.billingMonth,
      uoa_source_period_start: close.periodStartsAt.toISOString(),
      uoa_source_period_end: close.periodEndsAt.toISOString(),
    };
    const adjustmentStripe = (invoiceId: string, amount: number, lineId: string) => ({
      accounts: { retrieveCurrent: async () => ({ id: 'acct_org_billing' }) },
      invoices: {
        retrieve: async () => ({
          id: invoiceId, livemode: false, status: 'paid', billing_reason: 'manual',
          customer: 'cus_org_billing_team', currency: 'usd', amount_paid: amount,
          metadata,
        }),
        listLineItems: async () => ({
          has_more: false, data: [{ id: lineId, amount, currency: 'usd', metadata }],
        }),
      },
    });
    await expect(compensateFinalizedStripeInvoice({
      closeId: close.id, adjustmentInvoiceId: 'in_manual_adjustment_wrong',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T13:30:00.000Z'),
      now: new Date('2026-10-04T13:31:00.000Z'),
    }, {
      prisma, stripe: adjustmentStripe('in_manual_adjustment_wrong', 129, 'il_manual_wrong') as never,
    })).rejects.toThrow('STRIPE_INVOICE_ADJUSTMENT_EVIDENCE_MISMATCH');
    expect(await prisma.billingStripeInvoiceCloseResolution.count({ where: { closeId: close.id } }))
      .toBe(0);
    await compensateFinalizedStripeInvoice({
      closeId: close.id, adjustmentInvoiceId: 'in_manual_adjustment_exact',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T13:30:00.000Z'),
      now: new Date('2026-10-04T13:31:00.000Z'),
    }, {
      prisma, stripe: adjustmentStripe('in_manual_adjustment_exact', 130, 'il_manual_exact') as never,
    });
    const compensated = await prisma.billingStripeInvoiceClose.findUniqueOrThrow({
      where: { id: close.id },
    });
    expect(compensated.state).toBe('COMPENSATED');
    const evidence = await prisma.billingStripeInvoiceCloseResolution.findFirstOrThrow({
      where: { closeId: close.id },
    });
    expect(evidence.amountMicroMinor).toBe(130_000_000n);
    expect(evidence.stripeAdjustmentLineId).toBe('il_manual_exact');
    await expect(prisma.billingStripeInvoiceCloseResolution.create({
      data: {
        closeId: close.id, stripeAdjustmentInvoiceId: 'in_manual_adjustment_exact',
        stripeAdjustmentLineId: 'il_manual_duplicate', amountMicroMinor: 130_000_000n,
        paidAmountMinor: 130n,
        ledgerSnapshotCursor: held.ledgerSnapshotCursor!,
        actorEmail: 'billing-ops@example.test', observedAt,
      },
    })).rejects.toThrow();
    const later = await runStripeInvoiceCloseCycle({
      prisma, now: () => new Date('2026-10-04T15:00:00.000Z'),
      stripe: { invoices: { retrieve: async () => invoice } } as never,
      quote: async (params) => ({
        ledgerSnapshotCursor: 'bus_later_july_123456789',
        amountMicroMinor: params.paidAdjustmentsAmountMinor === 130n ? 70_000_000n : 200_000_000n,
        currency: 'USD',
      }),
    });
    expect(later).toEqual({ checked: 1, held: 0, unbilled: 1 });
    const reopened = await prisma.billingStripeInvoiceClose.findUniqueOrThrow({
      where: { id: close.id },
    });
    expect(reopened.state).toBe('FINALIZED_HOLD');
    expect(reopened.unbilledAmountMicroMinor).toBe(70_000_000n);
    await expect(prisma.billingStripeInvoiceClose.update({
      where: { id: close.id }, data: { billingMonth: '2026-08' },
    })).rejects.toThrow();
    await expect(prisma.billingStripeInvoiceCloseResolution.update({
      where: { id: evidence.id }, data: { amountMicroMinor: 1n },
    })).rejects.toThrow();
  });
});
