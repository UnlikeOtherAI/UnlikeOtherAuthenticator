import {
  BillingCreditEntryDirection, BillingCreditEntryKind,
  BillingCreditPaymentAdjustmentKind, BillingCreditPaymentInvoiceState,
  BillingCreditPaymentInvoiceSource, type Prisma,
} from '@prisma/client';

import {
  BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  type BillingCustomerInvoiceDetailV1,
  type BillingCustomerInvoiceSummaryV1,
  type BillingSubjectRequest,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { decimalCredits } from './billing-cycle-credit-evidence.service.js';
import { cycleMoney } from './billing-cycle-quote-projection.service.js';

export type PrepaidInvoiceSource = Prisma.BillingCreditPaymentInvoiceGetPayload<{
  include: { creditEntry: true; autoAttempt: { select: { id: true; currency: true } } };
}>;
type Adjustment = Prisma.BillingCreditPaymentAdjustmentGetPayload<Record<string, never>>;

function hold(): never {
  throw new AppError('INTERNAL', 503, 'BILLING_CUSTOMER_PREPAID_SOURCE_UNPROVEN');
}

function legalParty(value: Prisma.JsonValue | null): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).legal_name === 'string' &&
    Boolean((value as Record<string, unknown>).legal_name);
}

function adjustments(row: PrepaidInvoiceSource, rows: Adjustment[]) {
  let refunded = 0n;
  let disputed = 0n;
  for (const item of rows) {
    if (item.accountId !== row.accountId || item.livemode !== row.livemode ||
      item.creditAccountId !== row.creditAccountId || item.serviceId !== row.serviceId ||
      item.appKeyId !== row.appKeyId || item.originalEntryId !== row.creditEntryId ||
      item.stripePaymentIntentId !== row.stripePaymentIntentId ||
      item.stripeChargeId !== row.stripeChargeId || item.currency !== row.currency ||
      item.amountMinor <= 0n || item.amountMicrocredits <= 0n || !item.creditEntryId) hold();
    if (item.kind === BillingCreditPaymentAdjustmentKind.REFUND) refunded += item.amountMinor;
    else if (item.kind === BillingCreditPaymentAdjustmentKind.REFUND_REVERSAL) {
      refunded -= item.amountMinor;
    } else if (item.kind === BillingCreditPaymentAdjustmentKind.DISPUTE) {
      disputed += item.amountMinor;
    } else if (item.kind === BillingCreditPaymentAdjustmentKind.DISPUTE_REVERSAL) {
      disputed -= item.amountMinor;
    } else hold();
    if (refunded < 0n || disputed < 0n || refunded + disputed > row.grossAmountMinor) hold();
  }
  return { refunded, disputed };
}

export function projectPrepaidCustomerInvoiceSummary(
  row: PrepaidInvoiceSource, adjustmentRows: Adjustment[], serviceIdentifier: string,
): BillingCustomerInvoiceSummaryV1 {
  if (row.grossAmountMinor <= 0n || row.creditsPurchasedMicrocredits <= 0n ||
    row.creditEntryId !== row.creditEntry.id ||
    row.creditEntry.amountMicrocredits !== row.creditsPurchasedMicrocredits ||
    row.creditEntry.creditAccountId !== row.creditAccountId ||
    row.creditEntry.serviceId !== row.serviceId || row.creditEntry.appKeyId !== row.appKeyId ||
    row.creditEntry.attributedUserId !== row.attributedUserId ||
    row.creditEntry.direction !== BillingCreditEntryDirection.CREDIT ||
    (row.source === BillingCreditPaymentInvoiceSource.MANUAL_TOP_UP &&
      (row.creditEntry.kind !== BillingCreditEntryKind.TOP_UP ||
        row.creditEntry.sourceType !== 'credit_top_up_checkout' ||
        row.creditEntry.sourceId !== row.topUpCheckoutId)) ||
    (row.source === BillingCreditPaymentInvoiceSource.AUTO_RECHARGE &&
      (row.creditEntry.kind !== BillingCreditEntryKind.AUTOMATIC_TOP_UP ||
        row.creditEntry.sourceType !== 'credit_auto_top_up_attempt' ||
        row.creditEntry.sourceId !== row.autoTopUpAttemptId ||
        row.autoAttempt?.id !== row.autoTopUpAttemptId ||
        row.autoAttempt.currency !== row.currency)) ||
    row.creditEntry.currency !== row.currency ||
    row.paidAt.getTime() > Date.now() + 5 * 60_000 ||
    !row.stripePaymentIntentId || !row.stripeChargeId || !row.stripeCustomerId ||
    (row.source === BillingCreditPaymentInvoiceSource.MANUAL_TOP_UP &&
      (!row.topUpCheckoutId || row.autoTopUpAttemptId)) ||
    (row.source === BillingCreditPaymentInvoiceSource.AUTO_RECHARGE &&
      (!row.autoTopUpAttemptId || row.topUpCheckoutId))) hold();
  const issued = row.state === BillingCreditPaymentInvoiceState.ISSUED;
  if (issued && (!row.invoiceNumber || !row.issuedAt || !row.pdfObjectKey ||
    !row.pdfSha256 || row.taxAmountMinor === null || row.taxAmountMinor < 0n ||
    row.taxAmountMinor > row.grossAmountMinor || !row.taxSource ||
    !row.taxEvidenceReference || !row.issuerProfileId || !row.buyerProfileId ||
    !legalParty(row.issuerSnapshot) || !legalParty(row.buyerSnapshot))) hold();
  if (!issued && (row.invoiceNumber || row.issuedAt || row.pdfObjectKey || row.pdfSha256)) hold();
  const { refunded, disputed } = adjustments(row, adjustmentRows);
  const status = !issued ? 'pending_document' : disputed > 0n ?
    disputed === row.grossAmountMinor ? 'disputed' : 'partially_disputed' :
    refunded > 0n ? refunded === row.grossAmountMinor ? 'refunded' :
      'partially_refunded' : 'paid';
  const zero = cycleMoney(0n, row.currency);
  const gross = cycleMoney(row.grossAmountMinor, row.currency);
  return {
    invoice_id: `prepaid:${row.id}`, kind: 'prepaid_purchase', status,
    number: issued ? row.invoiceNumber : null,
    charged_at: row.paidAt.toISOString(), issued_at: issued ? row.issuedAt?.toISOString() ?? null : null,
    scope: { organisation_id: row.orgId, team_id: row.teamId,
      scope_type: row.teamId === null ? 'organisation' : 'team' },
    product_identifiers: [serviceIdentifier],
    totals: { currency: row.currency, gross_total: gross,
      tax: issued && row.taxAmountMinor !== null ? cycleMoney(row.taxAmountMinor, row.currency) : null,
      credits_applied: zero, voided_amount: zero, total_due: gross, total_paid: gross,
      refunded_amount: cycleMoney(refunded, row.currency),
      disputed_amount: cycleMoney(disputed, row.currency),
      write_off: zero, outstanding: zero },
    document_available: issued,
  };
}

export function projectPrepaidCustomerInvoiceDetail(
  row: PrepaidInvoiceSource, adjustmentRows: Adjustment[], serviceIdentifier: string,
  subject: BillingSubjectRequest,
): BillingCustomerInvoiceDetailV1 {
  const summary = projectPrepaidCustomerInvoiceSummary(row, adjustmentRows, serviceIdentifier);
  if (subject.product !== serviceIdentifier ||
    subject.organisation_id !== row.orgId ||
    (row.teamId !== null && subject.team_id !== row.teamId)) hold();
  const issued = summary.document_available;
  return { ...summary, schema_version: 1,
    charges: [{ line_id: row.creditEntryId, kind: 'prepaid_credits',
      label: row.source === BillingCreditPaymentInvoiceSource.AUTO_RECHARGE ?
        'Automatic prepaid credits purchase' : 'Prepaid credits purchase',
      // The accepted payment is tax-inclusive. Until the legal tax evidence
      // arrives, the pending charge deliberately shows the full paid amount.
      amount: cycleMoney(issued && row.taxAmountMinor !== null ?
        row.grossAmountMinor - row.taxAmountMinor : row.grossAmountMinor, row.currency),
      credits_purchased: decimalCredits(row.creditsPurchasedMicrocredits) }],
    document: issued && summary.number && summary.issued_at ? {
      document_id: `prepaid:${row.id}`, format: 'pdf',
      number: summary.number, issued_at: summary.issued_at,
      download_action: { method: 'POST', path: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
        body: { ...subject, invoice_id: `prepaid:${row.id}`,
          document_id: `prepaid:${row.id}` } },
    } : null,
  };
}
