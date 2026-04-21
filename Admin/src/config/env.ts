import { z } from 'zod';

const AdminEnvSchema = z.object({
  VITE_API_BASE_URL: z.string().url().optional(),
  VITE_ADMIN_CONFIG_URL: z.string().url().optional(),
  VITE_ADMIN_BYPASS_AUTH: z.enum(['true', 'false']).optional(),
});

const parsedEnv = AdminEnvSchema.parse(import.meta.env);

export const adminEnv = {
  apiBaseUrl: parsedEnv.VITE_API_BASE_URL ?? '',
  adminConfigUrl: parsedEnv.VITE_ADMIN_CONFIG_URL ?? '',
  bypassAuth: import.meta.env.DEV && parsedEnv.VITE_ADMIN_BYPASS_AUTH === 'true',
};
