import { z } from 'zod';

export const BillingModeSchema = z.enum(['standard', 'free', 'at_cost', 'custom']);
export const BillingCollectionModeSchema = z.enum(['stripe', 'manual', 'none']);

export const BillingTariffSchema = z.object({
  id: z.string(),
  service_id: z.string(),
  key: z.string(),
  version: z.number().int(),
  name: z.string(),
  mode: BillingModeSchema,
  collection_mode: BillingCollectionModeSchema,
  markup_bps: z.number().int(),
  monthly_subscription: z.object({
    amount_minor: z.string(),
    currency: z.string(),
  }),
  is_default: z.boolean(),
  created_by_email: z.string().nullable(),
  created_at: z.string(),
});

export const BillingAppKeySchema = z.object({
  id: z.string(),
  service_id: z.string().optional(),
  purpose: z.enum(['entitlement', 'customer_lifecycle']),
  name: z.string(),
  key_prefix: z.string(),
  actor_issuer: z.string(),
  actor_audience: z.string(),
  actor_key_id: z.string(),
  checkout_return_origins: z.array(z.string()),
  last_used_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_by_email: z.string().nullable(),
  created_at: z.string(),
});

export const BillingAssignmentSchema = z.object({
  id: z.string(),
  tariff_id: z.string(),
  scope: z.enum(['organisation', 'team']),
  organisation: z.object({ id: z.string(), name: z.string() }),
  team: z.object({ id: z.string(), name: z.string() }).nullable(),
  tariff: BillingTariffSchema,
  created_by_email: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BillingStripeSubscriptionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  stripe_account_id: z.string(),
  checkout_id: z.string(),
  tariff_id: z.string(),
  tariff_source: z.enum(['service_default', 'organisation', 'team']),
  tariff_assignment_id: z.string().nullable(),
  scope: z.enum(['organisation', 'team']),
  scope_key: z.string(),
  organisation: z.object({ id: z.string(), name: z.string() }),
  team: z.object({ id: z.string(), name: z.string() }).nullable(),
  stripe_subscription_id: z.string(),
  stripe_monthly_item_id: z.string().nullable(),
  stripe_usage_item_id: z.string(),
  status: z.string(),
  cancel_at_period_end: z.boolean(),
  current_period_start: z.string().nullable(),
  current_period_end: z.string().nullable(),
  livemode: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BillingServiceSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  name: z.string(),
  active: z.boolean(),
  tariffs: z.array(BillingTariffSchema),
  assignments: z.array(BillingAssignmentSchema),
  app_keys: z.array(BillingAppKeySchema),
  stripe_catalogs: z.array(z.object({ id: z.string() }).passthrough()),
  stripe_subscriptions: z.array(BillingStripeSubscriptionSchema),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BillingServicesSchema = z.array(BillingServiceSchema);
export const CreatedBillingAppKeySchema = BillingAppKeySchema.extend({ key: z.string() });

const tariffFields = {
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'Use lowercase letters, numbers, dots, _ or -.'),
  name: z.string().trim().min(1).max(120),
  mode: BillingModeSchema,
  collectionMode: BillingCollectionModeSchema,
  markupBps: z.coerce.number().int().min(0).max(100_000),
  monthlyAmountMinor: z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'Enter an integer in minor currency units.'),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
};

export const BillingTariffFormSchema = z
  .object({
    ...tariffFields,
    setAsDefault: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if ((value.mode === 'free' || value.mode === 'at_cost') && value.markupBps !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['markupBps'],
        message: 'Free and at-cost tariffs must use 0% markup.',
      });
    }
    if (
      value.mode === 'free' &&
      (value.monthlyAmountMinor !== '0' || value.collectionMode !== 'none')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'Free tariffs must have no subscription fee or payment collection.',
      });
    }
  });

export const BillingServiceFormSchema = z
  .object({
    identifier: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'Use a stable lowercase product identifier.'),
    serviceName: z.string().trim().min(1).max(120),
    ...tariffFields,
  })
  .superRefine((value, ctx) => {
    if ((value.mode === 'free' || value.mode === 'at_cost') && value.markupBps !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['markupBps'],
        message: 'Free and at-cost tariffs must use 0% markup.',
      });
    }
    if (
      value.mode === 'free' &&
      (value.monthlyAmountMinor !== '0' || value.collectionMode !== 'none')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'Free tariffs must have no subscription fee or payment collection.',
      });
    }
  });

export const BillingAssignmentFormSchema = z.object({
  organisationId: z.string().min(1, 'Select an organisation.'),
  teamId: z.string(),
  tariffId: z.string().min(1, 'Select a tariff.'),
});

export const BillingAppKeyFormSchema = z
  .object({
    purpose: z.enum(['entitlement', 'customer_lifecycle']),
    name: z.string().trim().min(1).max(120),
    actorIssuer: z.string().trim().url(),
    actorAudience: z.string().trim().url(),
    actorPublicJwkJson: z.string().trim().min(2),
    checkoutReturnOrigins: z.string(),
    expiresAt: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.purpose === 'customer_lifecycle' && !value.checkoutReturnOrigins.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkoutReturnOrigins'],
        message: 'At least one customer return origin is required.',
      });
    }
    if (value.purpose === 'entitlement' && value.checkoutReturnOrigins.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checkoutReturnOrigins'],
        message: 'Entitlement keys cannot have return origins.',
      });
    }
  });

export type BillingService = z.infer<typeof BillingServiceSchema>;
export type BillingTariff = z.infer<typeof BillingTariffSchema>;
export type BillingAssignment = z.infer<typeof BillingAssignmentSchema>;
export type BillingAppKey = z.infer<typeof BillingAppKeySchema>;
export type CreatedBillingAppKey = z.infer<typeof CreatedBillingAppKeySchema>;
export type BillingServiceFormValues = z.infer<typeof BillingServiceFormSchema>;
export type BillingTariffFormValues = z.infer<typeof BillingTariffFormSchema>;
export type BillingAssignmentFormValues = z.infer<typeof BillingAssignmentFormSchema>;
export type BillingAppKeyFormValues = z.infer<typeof BillingAppKeyFormSchema>;
