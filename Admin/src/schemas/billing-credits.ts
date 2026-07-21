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
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const BillingCreditAutoTopUpPreviewSchema = z.object({
  generation: z.number().int().nonnegative(),
  state: z.enum(['disabled', 'active', 'paused', 'requires_action', 'needs_review']),
  threshold_credits: BillingCreditAmountSchema.nullable(),
  refill_credits: BillingCreditAmountSchema.nullable(),
  consequence: z.object({
    code: z.enum([
      'not_active',
      'configuration_incomplete',
      'remains_above_threshold',
      'crosses_below_threshold',
      'remains_below_threshold',
      'crosses_above_threshold',
    ]),
    message: z.string(),
  }),
});

export const BillingCreditAdjustmentPreviewSchema = z.object({
  account: BillingCreditAccountSchema,
  current_credits: BillingCreditAmountSchema,
  signed_credits: BillingCreditAmountSchema,
  resulting_credits: BillingCreditAmountSchema,
  reason: z.string(),
  idempotency_key: z.string(),
  automatic_top_up: BillingCreditAutoTopUpPreviewSchema,
  expires_at: z.string(),
  confirmation_token: z.string(),
});

export const BillingCreditAdjustmentResponseSchema = z.object({
  account: BillingCreditAccountSchema,
  adjustment: BillingCreditAdjustmentSchema,
  replayed: z.boolean(),
});

const signedCreditsPattern = /^-?(0|[1-9]\d{0,12})(\.\d{1,5})?$/;
const maxCreditWhole = '9223372036854';
const maxCreditFraction = '77580';

function creditDeltaInRange(value: string): boolean {
  if (!signedCreditsPattern.test(value)) return false;
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (whole === '0' && !/[1-9]/.test(fraction)) return false;
  if (whole.length !== maxCreditWhole.length) return whole.length < maxCreditWhole.length;
  if (whole !== maxCreditWhole) return whole < maxCreditWhole;
  return fraction.padEnd(5, '0') <= maxCreditFraction;
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
export type BillingCreditAccountsResponse = z.infer<typeof BillingCreditAccountsResponseSchema>;
export type BillingCreditAdjustment = z.infer<typeof BillingCreditAdjustmentSchema>;
export type BillingCreditAdjustmentPreview = z.infer<typeof BillingCreditAdjustmentPreviewSchema>;
export type BillingCreditAdjustmentFormValues = z.infer<typeof BillingCreditAdjustmentFormSchema>;
