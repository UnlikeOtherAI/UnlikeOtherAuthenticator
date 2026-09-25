import { z } from 'zod';
import { tryParseRedirectUrl } from '../../utils/http-url.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const NativeAppIdentifier = z.string().max(160).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);

export function validNativeRedirect(value: string): boolean {
  const url = tryParseRedirectUrl(value);
  if (!url || url.username || url.password || url.hash) return false;
  if (url.protocol === 'http:') return ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:') return true;
  return NativeAppIdentifier.safeParse(url.protocol.slice(0, -1)).success;
}

/** Only registration accepts a varying numeric loopback port. Issued clients bind the exact URI. */
export function nativeRedirectMatches(allowed: string, requested: string): boolean {
  if (!validNativeRedirect(requested)) return false;
  if (allowed === requested) return true;
  const a = new URL(allowed);
  const b = new URL(requested);
  if (a.protocol !== 'http:' || b.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(a.hostname)) return false;
  a.port = b.port;
  return a.toString() === b.toString();
}

export const NativeAppPolicySchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  redirect_uris: z.array(z.string().max(2048).refine(validNativeRedirect)).min(1).max(10),
  scopes: z.array(z.enum(['openid', 'profile', 'email', 'settings.read', 'settings.write'])).min(1).max(5),
  methods: z.array(z.enum(['email_password', 'google'])).min(1).max(2),
  allow_registration: z.boolean(),
  primary_color: color,
  background_color: color,
  text_color: color,
}).strict();
export const CreateNativeAppSchema = NativeAppPolicySchema.extend({ identifier: NativeAppIdentifier });
export type NativeAppPolicy = z.infer<typeof NativeAppPolicySchema>;
