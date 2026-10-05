import {
  BillingCreditEntryDirection, BillingCreditEntryKind,
  BillingCreditPaymentAdjustmentKind, BillingCreditPaymentInvoiceSource,
  BillingCreditPaymentInvoiceState, type BillingCreditPaymentAdjustment,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  projectPrepaidCustomerInvoiceDetail, projectPrepaidCustomerInvoiceSummary,
  type PrepaidInvoiceSource,
} from '../../src/services/billing-customer-invoice-prepaid.service.js';

const subject = { product: 'nessie', organisation_id: 'org',
  team_id: 'team', user_id: 'viewer' };

function source(state: BillingCreditPaymentInvoiceState): PrepaidInvoiceSource {
  return { id: 'payment-1', accountId: 'account', livemode: false,
    stripePaymentIntentId: 'pi_1', stripeChargeId: 'ch_1', stripeInvoiceId: null,
    source: BillingCreditPaymentInvoiceSource.AUTO_RECHARGE,
    topUpCheckoutId: null, autoTopUpAttemptId: 'attempt',
    creditEntryId: 'credit-entry', creditAccountId: 'credit-account',
    appKeyId: 'app', serviceId: 'service', orgId: 'org', teamId: 'team',
    attributedUserId: 'buyer', stripeCustomerId: 'cus_1',
    currency: 'USD', grossAmountMinor: 5000n,
    creditsPurchasedMicrocredits: 50_000_000_000n,
    paidAt: new Date('2026-10-03T23:59:59.000Z'), state,
    invoiceNumber: state === BillingCreditPaymentInvoiceState.ISSUED ? 'UOA-1' : null,
    issuedAt: state === BillingCreditPaymentInvoiceState.ISSUED ?
      new Date('2026-11-01T01:00:00.000Z') : null,
    pdfObjectKey: state === BillingCreditPaymentInvoiceState.ISSUED ?
      'billing-invoices/one.pdf' : null,
    pdfSha256: state === BillingCreditPaymentInvoiceState.ISSUED ? 'a'.repeat(64) : null,
    taxAmountMinor: state === BillingCreditPaymentInvoiceState.ISSUED ? 0n : null,
    taxSource: state === BillingCreditPaymentInvoiceState.ISSUED ? 'ISSUER_POLICY' : null,
    taxEvidenceReference: state === BillingCreditPaymentInvoiceState.ISSUED ? 'policy-1' : null,
    issuerProfileId: state === BillingCreditPaymentInvoiceState.ISSUED ? 'issuer' : null,
    buyerProfileId: state === BillingCreditPaymentInvoiceState.ISSUED ? 'buyer' : null,
    issuerSnapshot: state === BillingCreditPaymentInvoiceState.ISSUED ?
      { legal_name: 'UOA Ltd' } : null,
    buyerSnapshot: state === BillingCreditPaymentInvoiceState.ISSUED ?
      { legal_name: 'Buyer Ltd' } : null,
    creditEntry: { id: 'credit-entry', creditAccountId: 'credit-account',
      serviceId: 'service', appKeyId: 'app', attributedUserId: 'buyer',
      direction: BillingCreditEntryDirection.CREDIT,
      kind: BillingCreditEntryKind.AUTOMATIC_TOP_UP,
      sourceType: 'credit_auto_top_up_attempt', sourceId: 'attempt',
      amountMicrocredits: 50_000_000_000n, currency: 'USD' },
    autoAttempt: { id: 'attempt', currency: 'USD' },
  } as unknown as PrepaidInvoiceSource;
}

function refund(amountMinor: bigint): BillingCreditPaymentAdjustment {
  return { id: 'refund-1', accountId: 'account', livemode: false,
    creditAccountId: 'credit-account', serviceId: 'service', appKeyId: 'app',
    originalEntryId: 'credit-entry', creditEntryId: 'debit-entry',
    kind: BillingCreditPaymentAdjustmentKind.REFUND,
    stripePaymentIntentId: 'pi_1', stripeChargeId: 'ch_1', currency: 'USD',
    amountMinor, amountMicrocredits: amountMinor * 10_000_000n,
  } as BillingCreditPaymentAdjustment;
}

describe('accepted prepaid invoice customer projection', () => {
  it('keeps an October accepted charge in October while its legal document is pending', () => {
    const pending = projectPrepaidCustomerInvoiceDetail(source(
      BillingCreditPaymentInvoiceState.HELD), [], 'nessie', subject);
    expect(pending.status).toBe('pending_document');
    expect(pending.charged_at).toBe('2026-10-03T23:59:59.000Z');
    expect(pending.number).toBeNull();
    expect(pending.issued_at).toBeNull();
    expect(pending.totals.tax).toBeNull();
    expect(pending.totals.total_paid.amount_minor).toBe('5000');
    expect(pending.charges[0]?.credits_purchased).toBe('50000');
    expect(pending.document).toBeNull();
    expect(JSON.stringify(pending)).not.toMatch(/provider_cost|markup|raw_units|token_count/i);
  });

  it('freezes a real legal PDF separately from refund and dispute financial effects', () => {
    const row = source(BillingCreditPaymentInvoiceState.ISSUED);
    const issued = projectPrepaidCustomerInvoiceDetail(row, [], 'nessie', subject);
    expect(issued.status).toBe('paid');
    expect(issued.document?.download_action.body.invoice_id).toBe('prepaid:payment-1');
    expect(issued.issued_at).toBe('2026-11-01T01:00:00.000Z');
    row.taxAmountMinor = 500n;
    const taxable = projectPrepaidCustomerInvoiceDetail(row, [], 'nessie', subject);
    expect(taxable.charges[0]?.amount.amount_minor).toBe('4500');
    expect(taxable.totals.gross_total.amount_minor).toBe('5000');
    expect(taxable.totals.tax?.amount_minor).toBe('500');
    const partial = projectPrepaidCustomerInvoiceSummary(row, [refund(2000n)], 'nessie');
    expect(partial.status).toBe('partially_refunded');
    expect(partial.totals.refunded_amount.amount_minor).toBe('2000');
    expect(partial.totals.outstanding.amount_minor).toBe('0');
    const full = projectPrepaidCustomerInvoiceSummary(row, [refund(5000n)], 'nessie');
    expect(full.status).toBe('refunded');
    expect(full.number).toBe(issued.number);
    expect(() => projectPrepaidCustomerInvoiceSummary(row, [refund(5001n)], 'nessie'))
      .toThrow('BILLING_CUSTOMER_PREPAID_SOURCE_UNPROVEN');
    expect(projectPrepaidCustomerInvoiceSummary(row, [{ ...refund(1000n),
      kind: BillingCreditPaymentAdjustmentKind.DISPUTE,
    }], 'nessie').status).toBe('partially_disputed');
  });

  it('rejects source rebinding and a guessed issued document', () => {
    const pending = source(BillingCreditPaymentInvoiceState.PENDING);
    pending.invoiceNumber = 'guessed';
    expect(() => projectPrepaidCustomerInvoiceSummary(pending, [], 'nessie')).toThrow();
    const issued = source(BillingCreditPaymentInvoiceState.ISSUED);
    issued.creditEntry.sourceId = 'other-attempt';
    expect(() => projectPrepaidCustomerInvoiceSummary(issued, [], 'nessie')).toThrow();
    const otherCurrency = source(BillingCreditPaymentInvoiceState.ISSUED);
    if (otherCurrency.autoAttempt) otherCurrency.autoAttempt.currency = 'EUR';
    expect(() => projectPrepaidCustomerInvoiceSummary(otherCurrency, [], 'nessie'))
      .toThrow('BILLING_CUSTOMER_PREPAID_SOURCE_UNPROVEN');
    expect(() => projectPrepaidCustomerInvoiceDetail(source(
      BillingCreditPaymentInvoiceState.ISSUED), [], 'nessie',
    { ...subject, team_id: 'other-team' })).toThrow();
  });
});
