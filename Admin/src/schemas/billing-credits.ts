import { z } from 'zod';

export const BillingCreditAmountSchema = z.object({
  credits: z.string(),
  display: z.string(),
  usd_equivalent: z.object({
    amount: z.string(),
    currency: z.literal('USD'),
    display: z.string(),
  }),
});

export const BillingCreditAdjustmentSchema = z.object({
  id: z.string(),
  signed_credits: BillingCreditAmountSchema,
  reason: z.string(),
  idempotency_key: z.string(),
  created_by: z.object({
    user_id: z.string(),
    email: z.string(),
    admin_domain: z.string(),
  }),
  created_at: z.string(),
});

export const BillingCreditAccountSchema = z.object({
  id: z.string(),
  organisation: z.object({ id: z.string(), name: z.string() }),
  team: z.object({ id: z.string(), name: z.string() }),
  mode: z.enum(['test', 'live']),
  remaining_credits: BillingCreditAmountSchema,
  updated_at: z.string(),
  recent_adjustments: z.array(BillingCreditAdjustmentSchema),
});

export const BillingCreditAccountsResponseSchema = z.object({
  accounts: z.array(BillingCreditAccountSchema),
});

export const BillingCreditAdjustmentResponseSchema = z.object({
  account: BillingCreditAccountSchema,
  adjustment: BillingCreditAdjustmentSchema,
  replayed: z.boolean(),
});

const signedCreditsPattern = /^-?(0|[1-9]\d{0,12})(\.\d{1,5})?$/;
const maxSignedMicrocredits = 9_223_372_036_854_775_807n;

function creditDeltaInRange(value: string): boolean {
  if (!signedCreditsPattern.test(value)) return false;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const microcredits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (microcredits === 0n) return false;
  return microcredits <= maxSignedMicrocredits;
}

export const BillingCreditAdjustmentFormSchema = z.object({
  signedCredits: z
    .string()
    .trim()
    .refine(
      creditDeltaInRange,
      'Enter a non-zero credit amount with no more than 5 decimal places.',
    ),
  reason: z.string().trim().min(1, 'Give a reason for this adjustment.').max(1000),
  idempotencyKey: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
      'Use a stable request reference containing letters, numbers, dots, _, : or -.',
    ),
});

export type BillingCreditAccount = z.infer<typeof BillingCreditAccountSchema>;
export type BillingCreditAdjustment = z.infer<typeof BillingCreditAdjustmentSchema>;
export type BillingCreditAdjustmentFormValues = z.infer<typeof BillingCreditAdjustmentFormSchema>;
