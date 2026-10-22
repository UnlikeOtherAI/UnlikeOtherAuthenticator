import { z } from 'zod';

const AuthFunnelCountSchema = z.object({ step: z.string(), outcome: z.string(), count: z.number().int().nonnegative() });

export const AuthFunnelSummarySchema = z.object({
  from: z.string(),
  to: z.string(),
  domain: z.string().nullable(),
  domains: z.array(z.string()),
  totals: z.array(AuthFunnelCountSchema),
  days: z.array(AuthFunnelCountSchema.extend({ day: z.string() })),
});

export type AuthFunnelCount = z.infer<typeof AuthFunnelCountSchema>;
export type AuthFunnelSummary = z.infer<typeof AuthFunnelSummarySchema>;
