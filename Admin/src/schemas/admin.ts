import { z } from 'zod';

export const LoginFormSchema = z.object({
  email: z.string().trim().email('Enter a valid admin email.'),
  password: z.string().min(1, 'Password is required.'),
  rememberDevice: z.boolean().default(false),
});

export type LoginFormValues = z.infer<typeof LoginFormSchema>;

export const DomainFormSchema = z.object({
  domain: z.string().trim().min(3, 'Domain is required.'),
  label: z.string().trim().min(1, 'Friendly name is required.'),
  secret: z.string().trim().min(32, 'Secret must be at least 32 characters.'),
});

export type DomainFormValues = z.infer<typeof DomainFormSchema>;

export const NewOrganisationFormSchema = z.object({
  name: z.string().trim().min(1, 'Organisation name is required.'),
  domain: z.string().trim().min(3, 'Domain is required.'),
  slug: z.string().trim().min(1, 'Slug is required.'),
  description: z.string().trim().optional(),
  ownerEmail: z.string().trim().email('Owner must be an existing user email.'),
});

export type NewOrganisationFormValues = z.infer<typeof NewOrganisationFormSchema>;

export const RegisterAppFormSchema = z.object({
  name: z.string().trim().min(1, 'App name is required.'),
  identifier: z.string().trim().min(1, 'Identifier is required.'),
  platform: z.enum(['ios', 'android', 'web', 'macos', 'windows', 'linux', 'iot', 'tv', 'console', 'other']),
  domain: z.string().trim().min(3, 'Domain is required.'),
  orgId: z.string().trim().min(1, 'Organisation is required.'),
});

export type RegisterAppFormValues = z.infer<typeof RegisterAppFormSchema>;

export const FeatureFlagFormSchema = z.object({
  key: z.string().trim().min(1, 'Flag key is required.').max(80, 'Flag key is too long.'),
  description: z.string().trim().max(500, 'Description is too long.').optional(),
  defaultState: z.enum(['enabled', 'disabled']),
});

export type FeatureFlagFormValues = z.infer<typeof FeatureFlagFormSchema>;

export const KillSwitchFormSchema = z.object({
  name: z.string().trim().max(120, 'Rule name is too long.').optional(),
  platform: z.string().trim().min(1, 'Platform is required.'),
  type: z.enum(['hard', 'soft', 'info', 'maintenance']),
  versionField: z.enum(['versionName', 'versionCode', 'buildNumber']),
  operator: z.enum(['lt', 'lte', 'eq', 'gte', 'gt', 'range']),
  versionValue: z.string().trim().min(1, 'Version value is required.').max(80, 'Version value is too long.'),
  versionMax: z.string().trim().max(80, 'Maximum is too long.').optional(),
  versionScheme: z.enum(['semver', 'integer', 'date', 'custom']),
  latestVersion: z.string().trim().max(80, 'Latest version is too long.').optional(),
  active: z.enum(['active', 'paused']),
  priority: z.coerce.number().int().min(0).max(1000),
  cacheTtl: z.coerce.number().int().min(60).max(86400),
});

export type KillSwitchFormValues = z.infer<typeof KillSwitchFormSchema>;
