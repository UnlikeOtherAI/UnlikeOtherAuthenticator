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

  it('carries an issued half-cent across a later cumulative settlement', () => {
    const original = allocateInvoiceCreditReferenceMinor([{ id: 'original',
      serviceId: 'service-a', settlementId: 'settlement-a',
      creditsAppliedMicrocredits: 5_000_000n }]);
    const supplement = allocateInvoiceCreditReferenceMinor([{ id: 'supplement',
      serviceId: 'service-a', settlementId: 'settlement-a',
      priorCreditsAppliedMicrocredits: 5_000_000n,
      creditsAppliedMicrocredits: 10_000_000n }]);
    expect(original[0]?.amountMinor).toBe(1n);
    expect(supplement[0]?.amountMinor).toBe(0n);
    expect(() => allocateInvoiceCreditReferenceMinor([{ id: 'invalid',
      serviceId: 'service-a', settlementId: 'settlement-a',
      priorCreditsAppliedMicrocredits: 10_000_000n,
      creditsAppliedMicrocredits: 5_000_000n }]))
      .toThrow('BILLING_INVOICE_CREDIT_REFERENCE_INVALID');
  });
});
