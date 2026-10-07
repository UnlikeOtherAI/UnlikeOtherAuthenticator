import { z } from 'zod';

export const BillingManualCreditNoteSchema = z.object({
  id: z.string().min(1),
  original_invoice_id: z.string().min(1),
  status: z.enum(['pending', 'issuing', 'issued']),
  number: z.string().nullable(),
  issued_at: z.string().datetime().nullable(),
  net_credit_minor: z.string().regex(/^(0|[1-9]\d*)$/),
  tax_credit_minor: z.string().regex(/^(0|[1-9]\d*)$/),
  total_credit_minor: z.string().regex(/^(0|[1-9]\d*)$/),
  currency: z.string().length(3),
  reason: z.string().min(1),
}).strict();

export type BillingManualCreditNote = z.infer<typeof BillingManualCreditNoteSchema>;
