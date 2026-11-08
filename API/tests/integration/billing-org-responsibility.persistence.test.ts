import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCreditAccount } from '../../src/services/billing-credit-account.service.js';
import { settleCreditPortfolio } from '../../src/services/billing-credit-settlement.service.js';
import { reconcileStripeUsageExport } from '../../src/services/billing-stripe-reconciliation.service.js';
import { recordStripeInvoiceClose } from '../../src/services/billing-stripe-invoice-close-state.service.js';
import { runStripeInvoiceCloseCycle } from '../../src/services/billing-stripe-invoice-close-scheduler.service.js';
import { compensateFinalizedStripeInvoice } from '../../src/services/billing-stripe-invoice-close-resolution.service.js';
import { readOrganisationBillingMode } from '../../src/services/billing-organisation-mode.service.js';
import {
  assumeOrgBillingResponsibility,
  releaseOrgBillingResponsibility,
} from '../../src/services/billing-org-responsibility-lifecycle.service.js';
import { createTestDb } from '../helpers/test-db.js';
import {
  credential, ids, lifecycleDeps, portfolio, request, seed,
} from './billing-org-responsibility.persistence.fixture.js';

const currentLive={id:'bsa_org_current_live',stripeAccountId:'acct_OrgCurrentLive',livemode:true};
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
    await prisma.billingStripeAccount.create({data:currentLive});
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('defaults both teams to one LIVE org wallet and leaves retained TEST funds separate',async()=>{
    const one=await resolveCreditAccount({account:currentLive,organisationId:ids.org,teamId:ids.teamA},{prisma});
    const two=await resolveCreditAccount({account:currentLive,organisationId:ids.org,teamId:ids.teamB},{prisma});
    expect(one).toMatchObject({scope:'ORGANISATION',teamId:null,scopeKey:ids.org,balanceMicrocredits:0n});
    expect(two.id).toBe(one.id);
    expect(await prisma.billingCreditAccount.findUniqueOrThrow({where:{id:ids.teamCreditAccount}}))
      .toMatchObject({scope:'TEAM',accountId:ids.account,balanceMicrocredits:500000000n});
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

    await expect(assumeOrgBillingResponsibility({request,actorToken:'signed-actor',credential},lifecycleDeps(prisma)))
      .rejects.toThrow('BILLING_ORGANISATION_SCOPE_REQUIRED');
    expect(await prisma.billingCancellationIntent.findUnique({where:{id:'bci_org_billing_open'}})).toMatchObject({state:'AVAILABLE'});
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

    expect((await readOrganisationBillingMode(ids.org,prisma)).blockers)
      .toContainEqual({code:'subscription',count:1});

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw(Prisma.sql`
        UPDATE "billing_stripe_subscriptions" SET "status" = 'canceled'
        WHERE "id" = 'bss_org_billing_team'
      `);
    });
  });

  it('refuses retired assume/release without switching wallets or rewriting history',async()=>{
    const before=await prisma.billingCreditAccount.findMany({orderBy:{id:'asc'}});
    for(const action of [assumeOrgBillingResponsibility,releaseOrgBillingResponsibility]) {
      await expect(action({request,actorToken:'signed-actor',credential},lifecycleDeps(prisma)))
        .rejects.toThrow('BILLING_ORGANISATION_SCOPE_REQUIRED');
    }
    expect(await prisma.billingCreditAccount.findMany({orderBy:{id:'asc'}})).toEqual(before);
    expect(await prisma.billingOrgResponsibility.count()).toBe(0);
  });
  it('does not debit historical TEST usage from the current LIVE organisation wallet',async()=>{
    const live=await resolveCreditAccount({account:currentLive,organisationId:ids.org,teamId:ids.teamB},{prisma});
    await expect(settleCreditPortfolio({creditAccountId:live.id,portfolio:portfolio(ids.teamB,'mup_wrong_live_history'),credential},{prisma}))
      .rejects.toThrow('BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED');
    expect(await prisma.billingCreditEntry.count({where:{creditAccountId:live.id}})).toBe(0);
    expect((await prisma.billingCreditAccount.findUniqueOrThrow({where:{id:ids.teamCreditAccount}})).balanceMicrocredits).toBe(500000000n);
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
      stripe: { accounts: { retrieveCurrent: async () => ({ id: 'acct_org_billing' }) },
        invoices: { retrieve: async () => invoice } } as never,
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
    const adjustmentStripe = (invoiceId: string, amount: number, lineId: string,
      paidCash = true, taxAmount = 0) => ({
      accounts: { retrieveCurrent: async () => ({ id: 'acct_org_billing' }) },
      invoices: {
        retrieve: async () => ({
          id: invoiceId, livemode: false, status: 'paid', billing_reason: 'manual',
          customer: 'cus_org_billing_team', currency: 'usd', amount_paid: amount + taxAmount,
          amount_due: amount + taxAmount, amount_remaining: 0, total: amount + taxAmount,
          total_taxes: taxAmount ? [{ amount: taxAmount }] : [], parent: null, metadata,
        }),
        listLineItems: async () => ({
          has_more: false, data: [{ id: lineId, invoice: invoiceId, livemode: false,
            amount, currency: 'usd', metadata, taxes: taxAmount ? [{ amount: taxAmount, tax_behavior: 'exclusive' }] : [], discount_amounts: [],
            parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: `ii_${invoiceId}` } },
            pretax_credit_amounts: [], period: { start: close.periodStartsAt.getTime() / 1000,
              end: close.periodEndsAt.getTime() / 1000 } }],
        }),
      },
      invoicePayments: { list: async () => ({ has_more: false, data: paidCash ? [{
        id: `inpay_${invoiceId}`, invoice: invoiceId, livemode: false, currency: 'usd',
        status: 'paid', amount_paid: amount + taxAmount,
        payment: { type: 'payment_intent', payment_intent: `pi_${invoiceId}` },
        status_transitions: { paid_at: 1791118800 },
      }] : [] }) },
      paymentIntents: { retrieve: async () => ({ id: `pi_${invoiceId}`, livemode: false,
        customer: 'cus_org_billing_team', currency: 'usd', status: 'succeeded',
        amount_received: amount + taxAmount, latest_charge: `ch_${invoiceId}` }) },
      charges: { retrieve: async () => ({ id: `ch_${invoiceId}`, livemode: false,
        customer: 'cus_org_billing_team', currency: 'usd', status: 'succeeded',
        payment_intent: `pi_${invoiceId}`, paid: true, captured: true, amount_captured: amount + taxAmount }) },
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
    await expect(compensateFinalizedStripeInvoice({
      closeId: close.id, adjustmentInvoiceId: 'in_manual_no_cash',
      actorEmail: 'billing-ops@example.test', observedAt: new Date('2026-10-04T13:30:00.000Z'),
    }, { prisma, stripe: adjustmentStripe('in_manual_no_cash', 130, 'il_no_cash', false) as never }))
      .rejects.toThrow('STRIPE_SUBSCRIPTION_PAYMENT_SET_UNPROVEN');
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
      stripe: { accounts: { retrieveCurrent: async () => ({ id: 'acct_org_billing' }) },
        invoices: { retrieve: async () => invoice } } as never,
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
    await compensateFinalizedStripeInvoice({ closeId: close.id,
      adjustmentInvoiceId: 'in_manual_adjustment_vat', actorEmail: 'billing-ops@example.test',
      observedAt: new Date('2026-10-04T15:30:00.000Z'),
    }, { prisma, stripe: adjustmentStripe('in_manual_adjustment_vat', 70, 'il_vat', true, 14) as never });
    const legalSource = await prisma.billingStripePaymentInvoice.findFirstOrThrow({
      where: { stripeInvoiceId: 'in_manual_adjustment_vat' }, include: { lines: true, cashPayments: true } });
    expect(legalSource).toMatchObject({ grossAmountMinor: 84n, taxAmountMinor: 14n,
      paidAmountMinor: 84n, state: 'PENDING' });
    expect(legalSource.lines[0]).toMatchObject({ usageMinor: 70n, subscriptionMinor: 0n,
      taxMinor: 14n, billingMonth: '2026-07' });
    expect(legalSource.cashPayments[0]?.amountMinor).toBe(84n);
    expect((await prisma.billingStripeInvoiceCloseResolution.findFirstOrThrow({
      where: { stripeAdjustmentInvoiceId: 'in_manual_adjustment_vat' } })).paidAmountMinor).toBe(70n);

    await expect(prisma.billingStripeInvoiceClose.update({
      where: { id: close.id }, data: { billingMonth: '2026-08' },
    })).rejects.toThrow();
    await expect(prisma.billingStripeInvoiceCloseResolution.update({
      where: { id: evidence.id }, data: { amountMicroMinor: 1n },
    })).rejects.toThrow();
  });
});
