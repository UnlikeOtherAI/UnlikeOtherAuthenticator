import { z } from 'zod';
import { adminConfigUrl } from '../features/auth/admin-oauth';
import { createApiClient } from './api-client';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const issued = z.object({ url: z.string().url(), token, expires_in: z.number().nonnegative() }).strict();
const pair = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), token_type: z.literal('Bearer') }).strict();
const path = (action: string) => `/internal/admin/${action}?config_url=${encodeURIComponent(adminConfigUrl())}`;
export async function issueAdminDebugLogin(previousToken?: string) {
  return issued.parse(await createApiClient().post(path('debug-login/issue'), { previous_token: previousToken }));
}
export function parseAdminDebugLogin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return token.parse(trimmed);
  const parsed = z.object({ url: z.string().url(), token }).strict().parse(JSON.parse(trimmed));
  if (parsed.url !== new URL('/admin/login', adminConfigUrl()).toString()) throw new Error('Wrong debug login destination');
  return parsed.token;
}
export async function redeemAdminDebugLogin(input: string) {
  const result = pair.parse(await createApiClient().post(path('debug-login/redeem'), { token: parseAdminDebugLogin(input) }));
  return result;
}
export async function logoutAdminSession(accessToken: string) {
  await createApiClient().post(path('logout'), {}, { headers: { Authorization: `Bearer ${accessToken}` } });
}
