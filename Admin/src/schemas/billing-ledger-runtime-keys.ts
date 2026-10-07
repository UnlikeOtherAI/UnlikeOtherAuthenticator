import { z } from 'zod';

export const BillingLedgerRuntimeKeySchema = z.object({
  id: z.string().min(1),
  product: z.string().min(1),
  key_prefix: z.string().min(1),
  ledger_audience: z.string().url(),
  source_domain: z.string().min(1),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
}).strict();
export const BillingLedgerRuntimeKeysSchema = z.object({
  keys: z.array(BillingLedgerRuntimeKeySchema),
}).strict();
export const CreatedBillingLedgerRuntimeKeySchema = z.object({
  id: z.string().min(1),
  key_prefix: z.string().min(1),
  created_at: z.string().datetime(),
  secret: z.string().regex(/^uoa_ledger_[A-Za-z0-9_-]{43}$/),
}).strict();
export const RevokedBillingLedgerRuntimeKeySchema = z.object({
  id: z.string().min(1), revoked_at: z.string().datetime().nullable(),
}).strict();

export const BillingLedgerRuntimeKeyFormSchema = z.object({
  sourceDomain: z.string().trim().min(1, 'Enter the original product source domain.')
    .max(255).refine((value) => /^[a-z0-9.-]+$/i.test(value)
      && !value.startsWith('.') && !value.endsWith('.'),
    'Use the config domain hostname without a protocol or path.'),
  ledgerAudience: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    } catch { return false; }
  }, 'Use the exact HTTPS Ledger origin without a path or trailing slash.'),
}).strict();
export type BillingLedgerRuntimeKeyFormValues = z.infer<typeof BillingLedgerRuntimeKeyFormSchema>;
export type CreatedBillingLedgerRuntimeKey = z.infer<typeof CreatedBillingLedgerRuntimeKeySchema>;
