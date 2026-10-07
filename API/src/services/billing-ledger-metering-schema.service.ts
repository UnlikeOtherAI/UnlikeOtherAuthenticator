import { z } from 'zod';

export const ProductSchema = z.enum(['nessie', 'deepwater', 'deepsignal', 'deeptest', 'docgen', 'salesnerd']);
export const BillingCompletenessSchema = z.object({
  state: z.enum(['complete', 'unresolved']),
  unresolvedPaidAttempts: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict().refine((value) =>
  (value.state === 'complete') === (value.unresolvedPaidAttempts === '0'),
);
const IntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const DecimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const AttributionProductSchema = z.string().trim().min(1).max(128);
const ProductDimensionsSchema = z
  .object({
    billingProduct: ProductSchema,
    callerProduct: AttributionProductSchema.nullable(),
    originProduct: AttributionProductSchema.nullable(),
  })
  .strict();

const RawUsageBreakdownSchema = z.object({
  thoughtOutputTokens: IntegerSchema.optional(),
  cacheWrite5mTokens: IntegerSchema.optional(),
  cacheWrite1hTokens: IntegerSchema.optional(),
  inputTextTokens: IntegerSchema.optional(),
  inputImageTokens: IntegerSchema.optional(),
  inputAudioTokens: IntegerSchema.optional(),
  outputImageTokens: IntegerSchema.optional(),
  outputAudioTokens: IntegerSchema.optional(),
  cachedImageTokens: IntegerSchema.optional(),
  cachedAudioTokens: IntegerSchema.optional(),
  toolUseInputTokens: IntegerSchema.optional(),
  rawInputTokens: IntegerSchema.optional(),
  rawOutputTokens: IntegerSchema.optional(),
  unattributedTokens: IntegerSchema.optional(),
}).strict();

const UsageRowSchema = ProductDimensionsSchema.extend({
  serviceId: z.string().trim().min(1).max(512),
  usageUnit: z.string().trim().min(1).max(512),
  calls: IntegerSchema,
  rawProviderUsage: z
    .object({
      unitsIn: IntegerSchema,
      unitsCachedIn: IntegerSchema,
      unitsOut: IntegerSchema,
      breakdown: RawUsageBreakdownSchema.optional(),
    })
    .strict(),
}).strict();

const CostFieldsSchema = {
  costProvenance: z.string().trim().min(1).max(512),
  rawProviderCurrency: CurrencySchema.nullable(),
  rawProviderEstimatedCost: DecimalSchema.nullable(),
  rawProviderActualCost: DecimalSchema.nullable(),
  rawProviderSelectedCost: DecimalSchema.nullable(),
} as const;

const CostRowSchema = ProductDimensionsSchema.extend({
  serviceId: z.string().trim().min(1).max(512),
  calls: IntegerSchema,
  billingDisposition: z.enum(['paid', 'nonbillable']),
  ...CostFieldsSchema,
}).strict();

export const BreakdownRowSchema = UsageRowSchema.extend({
  dimension: z.string().trim().min(1).max(512).nullable(),
  billingDisposition: z.enum(['paid', 'nonbillable']),
  ...CostFieldsSchema,
}).strict();

export const MeteringScopeSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256).nullable(),
    userId: z.string().trim().min(1).max(256).nullable(),
    month: MonthSchema.nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict();

const MeteringPortfolioScopeSchema = z
  .object({
    organizationId: z.string().trim().min(1).max(256),
    teamId: z.string().trim().min(1).max(256),
    month: MonthSchema,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict();

export const MeteringTotalsSchema = z
  .object({
    calls: IntegerSchema,
    usageByService: z.array(UsageRowSchema),
    costs: z.array(CostRowSchema),
  })
  .strict();

const MeteringUsageEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: ProductSchema,
    scope: MeteringScopeSchema,
    totals: MeteringTotalsSchema,
    groupBy: z.enum(['service', 'team', 'user']),
    billingCompleteness: BillingCompletenessSchema,
    breakdown: z.array(BreakdownRowSchema),
    snapshot: z
      .object({
        cursor: z.string().regex(/^mus_[A-Za-z0-9_-]{32}$/),
        id: z.string().regex(/^mus_[A-Za-z0-9_-]{32}$/),
        capturedAt: z.string().datetime(),
        immutable: z.literal(true),
      })
      .strict(),
  })
  .strict();

function requireSameSnapshotCursor(
  value: { snapshot: { cursor: string; id: string } }, context: z.RefinementCtx,
): void {
    if (value.snapshot.cursor !== value.snapshot.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot', 'id'],
        message: 'snapshot id must equal cursor',
      });
    }
}

export const LedgerMeteringUsageSchema = MeteringUsageEnvelopeSchema.extend({
  groupBy: z.enum(['service', 'user']),
}).superRefine(requireSameSnapshotCursor);

export const LedgerMeteringTeamUsageSchema = MeteringUsageEnvelopeSchema.extend({
  groupBy: z.literal('team'),
}).superRefine(requireSameSnapshotCursor);

export type LedgerMeteringUsage = z.infer<typeof LedgerMeteringUsageSchema>;

export const LedgerMeteringPortfolioSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal('metering-portfolio-v1'),
    perspectiveProduct: ProductSchema,
    scope: MeteringPortfolioScopeSchema,
    totals: MeteringTotalsSchema,
    groupBy: z.enum(['service', 'user']),
    billingCompleteness: BillingCompletenessSchema,
    breakdown: z.array(BreakdownRowSchema),
    snapshot: z
      .object({
        cursor: z.string().regex(/^mup_[A-Za-z0-9_-]{32}$/),
        id: z.string().regex(/^mup_[A-Za-z0-9_-]{32}$/),
        capturedAt: z.string().datetime(),
        immutable: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.snapshot.cursor !== value.snapshot.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot', 'id'],
        message: 'snapshot id must equal cursor',
      });
    }
  });

export type LedgerMeteringPortfolio = z.infer<typeof LedgerMeteringPortfolioSchema>;
