import { describe, expect, it } from 'vitest';

import { allocateInvoiceCreditReferenceMinor } from '../../src/services/billing-invoice-line-credit-allocation.service.js';

describe('invoice credit reference allocation', () => {
  it('rounds one global cent across two service references and preserves carry', () => {
    const result = allocateInvoiceCreditReferenceMinor([
      { id: 'second', serviceId: 'service-b', settlementId: 'settlement-b',
        creditsAppliedMicrocredits: 5_000_000n },
      { id: 'first', serviceId: 'service-a', settlementId: 'settlement-a',
        creditsAppliedMicrocredits: 5_000_000n },
    ]);
    expect(result).toEqual([
      { referenceId: 'first', serviceId: 'service-a', amountMinor: 1n },
      { referenceId: 'second', serviceId: 'service-b', amountMinor: 0n },
    ]);
    expect(result.reduce((total, row) => total + row.amountMinor, 0n)).toBe(1n);
  });

  it('rejects duplicate or negative source references', () => {
    expect(() => allocateInvoiceCreditReferenceMinor([
      { id: 'duplicate', serviceId: 'a', settlementId: 'a',
        creditsAppliedMicrocredits: 0n },
      { id: 'duplicate', serviceId: 'b', settlementId: 'b',
        creditsAppliedMicrocredits: 0n },
    ])).toThrow('BILLING_INVOICE_CREDIT_REFERENCE_INVALID');
    expect(() => allocateInvoiceCreditReferenceMinor([
      { id: 'negative', serviceId: 'a', settlementId: 'a',
        creditsAppliedMicrocredits: -1n },
    ])).toThrow('BILLING_INVOICE_CREDIT_REFERENCE_INVALID');
  });
});
