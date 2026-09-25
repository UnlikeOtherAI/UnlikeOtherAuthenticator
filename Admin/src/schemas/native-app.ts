import { z } from 'zod';
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const NativeAppFormSchema = z.object({
  identifier: z.string().min(3).max(160).regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  scopes: z.array(z.enum(['openid', 'profile', 'email', 'settings.read', 'settings.write'])).min(1).max(5),
  methods: z.array(z.enum(['email_password', 'google'])).min(1).max(2),
  allow_registration: z.boolean(), primary_color: color, background_color: color, text_color: color,
});
export const NativeAppSchema = NativeAppFormSchema.extend({ id: z.string(), revision: z.number().int(), icon_url: z.string().url().nullable() });
export type NativeApp = z.infer<typeof NativeAppSchema>;
export type NativeAppForm = z.infer<typeof NativeAppFormSchema>;
