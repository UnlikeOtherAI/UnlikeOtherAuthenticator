import { z } from 'zod';
import { AdminMachinesSchema } from '../schemas/machines';
import { createApiClient } from './api-client';

const path = (userId: string) => `/internal/admin/users/${encodeURIComponent(userId)}/machines`;
export const machineService = {
  list: async (userId: string) => AdminMachinesSchema.parse(await createApiClient().get(path(userId))),
  revoke: async (userId: string, enrollmentId?: string) => z.object({ ok: z.literal(true), version: z.literal(1) }).strict()
    .parse(await createApiClient().post(`${path(userId)}/revoke`, enrollmentId ? { enrollment_id: enrollmentId } : {})),
};
