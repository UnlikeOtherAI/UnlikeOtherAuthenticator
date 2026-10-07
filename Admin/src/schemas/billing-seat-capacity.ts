import { z } from 'zod';

export const BillingSeatSubscriptionSchema = z.object({
  id: z.string(),
  service_id: z.string(),
  organisation: z.object({ id: z.string(), name: z.string() }),
  team: z.object({ id: z.string(), name: z.string() }).nullable(),
  source: z.enum(['stripe', 'manual']),
  seat_policy: z.enum(['automatic', 'fixed']),
  seat_charge_timing: z.enum(['full_month', 'prorated']),
  baseline_member_count: z.number().int().nonnegative().nullable(),
  activated_at: z.string(),
  ended_at: z.string().nullable(),
  current_capacity: z.number().int().positive().nullable(),
  capacity_revisions: z.array(z.object({
    id: z.string(), quantity: z.number().int().positive(), effective_at: z.string(),
  })),
});

export const BillingSeatSubscriptionsSchema = BillingSeatSubscriptionSchema.array();
export type BillingSeatSubscription = z.infer<typeof BillingSeatSubscriptionSchema>;
