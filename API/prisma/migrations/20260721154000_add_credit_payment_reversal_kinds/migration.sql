-- Refund failures and dispute reinstatements restore only credits previously
-- removed by exact Stripe evidence. Separate kinds make the direction and
-- source adjustment immutable and auditable.
ALTER TYPE "BillingCreditEntryKind" ADD VALUE 'REFUND_REVERSAL';
ALTER TYPE "BillingCreditEntryKind" ADD VALUE 'DISPUTE_REVERSAL';
ALTER TYPE "BillingCreditPaymentAdjustmentKind" ADD VALUE 'REFUND_REVERSAL';
ALTER TYPE "BillingCreditPaymentAdjustmentKind" ADD VALUE 'DISPUTE_REVERSAL';
