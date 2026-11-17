import { z } from 'zod';

const Amount = z.object({
  microcredits: z.string().regex(/^-?\d+$/),
  credits: z.string(),
  usd: z.string(),
}).strict();

export const BillingCreditGrantSchema = z.object({
  id: z.string(), credit_entry_id: z.string(), amount: Amount, reason: z.string(),
  granted_by: z.string(), granted_at: z.string().datetime(), mode: z.enum(['live', 'sandbox']),
}).strict();

export const BillingOrganisationCreditGrantsSchema = z.object({
  organisation: z.object({ id: z.string(), name: z.string() }).strict(),
  mode: z.enum(['live', 'sandbox']),
  credit_account_id: z.string().nullable(),
  balance: z.object({ confirmed: Amount, reserved: Amount, spendable: Amount }).strict(),
  limits: z.object({ max_credits: z.string().regex(/^\d+$/), reason_min: z.number().int(),
    reason_max: z.number().int() }).strict(),
  grants: z.array(BillingCreditGrantSchema),
  has_more: z.boolean(),
}).strict();

export const BillingCreditGrantResultSchema = z.object({
  grant: BillingCreditGrantSchema, replayed: z.boolean(), balance_after: Amount,
}).strict();

export type BillingCreditAmount = z.infer<typeof Amount>;
export type BillingCreditGrant = z.infer<typeof BillingCreditGrantSchema>;
export type BillingOrganisationCreditGrants = z.infer<typeof BillingOrganisationCreditGrantsSchema>;
export type BillingCreditGrantResult = z.infer<typeof BillingCreditGrantResultSchema>;
