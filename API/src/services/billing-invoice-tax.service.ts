import { AppError } from '../utils/errors.js';

export type BillingInvoiceTaxTerms = {
  treatment: 'NO_TAX_CHARGED' | 'STANDARD_RATE';
  rateBps: number;
  legalBasis: string;
};

export function assertInvoiceTaxTerms(value: BillingInvoiceTaxTerms): BillingInvoiceTaxTerms {
  if (!value || !Number.isInteger(value.rateBps) ||
    !value.legalBasis?.trim() || value.legalBasis.length > 500 ||
    ((value.treatment === 'NO_TAX_CHARGED') !== (value.rateBps === 0)) ||
    value.rateBps < 0 || value.rateBps > 10000) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_INVOICE_TAX_TERMS_INVALID');
  }
  return { ...value, legalBasis: value.legalBasis.trim() };
}

/** Rounds cumulative taxable net once, then allocates its cents by issuer line. */
export function allocateInvoiceTaxMinor(
  lines: readonly { id: string; netMinor: bigint }[], terms: BillingInvoiceTaxTerms,
): Map<string, bigint> {
  assertInvoiceTaxTerms(terms);
  let cumulativeNet = 0n;
  let previousTax = 0n;
  const result = new Map<string, bigint>();
  for (const line of lines) {
    if (line.netMinor < 0n || result.has(line.id)) {
      throw new AppError('INTERNAL', 500, 'BILLING_INVOICE_TAX_LINE_INVALID');
    }
    cumulativeNet += line.netMinor;
    const currentTax = (cumulativeNet * BigInt(terms.rateBps) + 5000n) / 10000n;
    result.set(line.id, currentTax - previousTax);
    previousTax = currentTax;
  }
  return result;
}
