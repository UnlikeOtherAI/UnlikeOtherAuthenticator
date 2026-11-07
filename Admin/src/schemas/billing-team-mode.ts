import { z } from 'zod';

export const BillingTeamModeSchema = z.object({
  organisation_id: z.string(), team_id: z.string(), mode: z.enum(['live', 'sandbox']),
  revision: z.number().int().nonnegative(),
  blockers: z.array(z.object({ code: z.string(), count: z.number().int().positive() }).strict()),
}).strict();
export type BillingTeamMode = z.infer<typeof BillingTeamModeSchema>;
