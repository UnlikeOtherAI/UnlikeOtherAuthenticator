import { AppError } from '../utils/errors.js';

const MICROCREDITS_PER_USD_MINOR = 10_000_000n;
const binaryCompare = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

export type InvoiceCreditReference = {
  id: string;
  serviceId: string;
  settlementId: string;
  creditsAppliedMicrocredits: bigint;
  priorCreditsAppliedMicrocredits?: bigint;
};

/**
 * Invoice credits round only once across every settled reference. Stable
 * reference order assigns each rounded cent to the same actual service line;
 * the persisted rows are checked again by PostgreSQL before issue.
 */
export function allocateInvoiceCreditReferenceMinor(
  references: readonly InvoiceCreditReference[],
): Array<{ referenceId: string; serviceId: string; amountMinor: bigint }> {
  let cumulative = references.reduce((sum, reference) => {
    const prior = reference.priorCreditsAppliedMicrocredits ?? 0n;
    if (prior < 0n || prior > reference.creditsAppliedMicrocredits) {
      throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_REFERENCE_INVALID');
    }
    return sum + prior;
  }, 0n);
  const seen = new Set<string>();
  return [...references].sort((a, b) =>
    binaryCompare(a.serviceId, b.serviceId) ||
    binaryCompare(a.settlementId, b.settlementId) || binaryCompare(a.id, b.id))
    .map((reference) => {
      if (reference.creditsAppliedMicrocredits < 0n || seen.has(reference.id)) {
        throw new AppError('BAD_REQUEST', 409, 'BILLING_INVOICE_CREDIT_REFERENCE_INVALID');
      }
      seen.add(reference.id);
      const before = (cumulative + MICROCREDITS_PER_USD_MINOR / 2n) /
        MICROCREDITS_PER_USD_MINOR;
      cumulative += reference.creditsAppliedMicrocredits -
        (reference.priorCreditsAppliedMicrocredits ?? 0n);
      const after = (cumulative + MICROCREDITS_PER_USD_MINOR / 2n) /
        MICROCREDITS_PER_USD_MINOR;
      return { referenceId: reference.id, serviceId: reference.serviceId,
        amountMinor: after - before };
    });
}
