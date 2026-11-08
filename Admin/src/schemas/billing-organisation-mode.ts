import { z } from 'zod';

export const BillingOrganisationModeSchema = z.object({
  organisation_id: z.string(), mode: z.enum(['live', 'sandbox']),
  revision: z.number().int().nonnegative(),
  epoch:z.string().datetime(),
  blockers: z.array(z.object({ code: z.string(), count: z.number().int().positive() }).strict()),
}).strict();
export type BillingOrganisationMode = z.infer<typeof BillingOrganisationModeSchema>;
