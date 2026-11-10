import { z } from 'zod';

export const AdminMachinesSchema = z.object({ version: z.literal(1), truncated: z.boolean(), data: z.array(z.object({
  enrollment_id: z.uuid(), device_name: z.string(), client_domain: z.string(), organization_id: z.string(), team_id: z.string(),
  organization_name: z.string().nullable(), team_name: z.string().nullable(),
  decision: z.enum(['allowed', 'reauthorization_required', 'revoked', 'access_removed']), reason: z.string(), created_at: z.iso.datetime(),
}).strict()).max(100) }).strict();
export type AdminMachine = z.infer<typeof AdminMachinesSchema>['data'][number];
