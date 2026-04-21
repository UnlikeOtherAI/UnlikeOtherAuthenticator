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
  slug: z.string().trim().min(1, 'Slug is required.'),
  description: z.string().trim().optional(),
  ownerEmail: z.string().trim().email('Owner must be an existing user email.'),
});

export type NewOrganisationFormValues = z.infer<typeof NewOrganisationFormSchema>;
