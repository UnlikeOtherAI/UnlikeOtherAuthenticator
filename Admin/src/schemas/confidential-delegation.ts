import { z } from 'zod';

export const ConfidentialDelegationScopeSchema = z.enum([
  'ai.invoke',
  'billing.read',
  'token.provision',
]);

export const ConfidentialDelegationScopesSchema = z
  .array(ConfidentialDelegationScopeSchema)
  .min(1, 'Select at least one scope.')
  .max(3)
  .refine((scopes) => new Set(scopes).size === scopes.length, {
    message: 'Each scope may only be selected once.',
  });

const SourceDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Source domain is required.')
  .max(253)
  .refine((value) => {
    try {
      const url = new URL(`https://${value}`);
      return url.hostname === value && url.pathname === '/' && !url.port;
    } catch {
      return false;
    }
  }, 'Enter a hostname without a protocol, path, or port.');

const ProductSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,99}$/,
    'Use lowercase letters, numbers, dots, underscores, or hyphens.',
  );

const ResourceSchema = z
  .string()
  .trim()
  .min(1, 'Resource is required.')
  .max(2048)
  .url('Enter a valid HTTPS resource URL.')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }, 'Resource must be HTTPS and must not contain credentials or a fragment.');

export const ConfidentialDelegationMappingSchema = z.object({
  id: z.string().min(1),
  source_domain: SourceDomainSchema,
  product: ProductSchema,
  resource: ResourceSchema,
  scopes: ConfidentialDelegationScopesSchema,
  enabled: z.boolean(),
  created_by_email: z.string().email().nullable(),
  updated_by_email: z.string().email().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const ConfidentialDelegationMappingListSchema = z.array(ConfidentialDelegationMappingSchema);

export const ConfidentialDelegationFormSchema = z.object({
  sourceDomain: SourceDomainSchema,
  product: ProductSchema,
  resource: ResourceSchema,
  scopes: ConfidentialDelegationScopesSchema,
  enabled: z.boolean().default(true),
});

export type ConfidentialDelegationScope = z.infer<typeof ConfidentialDelegationScopeSchema>;
export type ConfidentialDelegationMapping = z.infer<typeof ConfidentialDelegationMappingSchema>;
export type ConfidentialDelegationFormValues = z.infer<typeof ConfidentialDelegationFormSchema>;
