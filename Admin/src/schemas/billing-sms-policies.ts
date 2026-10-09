import { z } from 'zod';

const decimal = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/,
  'Enter a nonnegative decimal with at most 18 fractional digits.');
export const SmsFxEvidenceSchema = z.object({
  policy: z.literal('ECB_REFERENCE_USD_PER_EUR_V1'),
  source: z.literal('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/), rate_date: z.string().date(),
  observed_at: z.string().datetime(), expires_at: z.string().datetime(), usd_per_eur: decimal,
}).strict();
export const SmsRouteImportSchema = z.object({
  account_sid: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'Enter the exact Twilio account SID.'),
  country: z.string().regex(/^[A-Z]{2}$/, 'Enter the two-letter country code.'),
  direction: z.enum(['inbound', 'outbound']), currency: z.enum(['USD', 'EUR']),
  additional_per_segment: decimal, additional_per_message: decimal,
  source: z.string().trim().min(8).max(500), evidence: z.string().trim().min(20).max(32_000),
  expires_at: z.string().datetime({ offset: true, message: 'Enter a UTC or offset timestamp.' }),
}).strict();
export const SmsRouteEvidenceSchema = SmsRouteImportSchema.omit({ evidence: true }).extend({
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.string().datetime(),
}).strict();
const accepted = { id: z.string(), accepted_by_user_id: z.string(),
  accepted_at: z.string().datetime(), acceptance_reason: z.string() };
export const SmsFxPolicySchema = SmsFxEvidenceSchema.extend(accepted).strict();
export const SmsRoutePolicySchema = SmsRouteEvidenceSchema.omit({ observed_at: true })
  .extend(accepted).strict();
export const SmsPoliciesSchema = z.object({ fx: z.array(SmsFxPolicySchema),
  routes: z.array(SmsRoutePolicySchema) }).strict();
const preview = { preview_token: z.string(), preview_expires_at: z.string().datetime() };
export const SmsFxPreviewSchema = z.object({ ...preview, evidence: SmsFxEvidenceSchema }).strict();
export const SmsRoutePreviewSchema = z.object({ ...preview, evidence: SmsRouteEvidenceSchema,
  evidence_document: z.string().max(32_000) }).strict();
export type SmsFxPreview = z.infer<typeof SmsFxPreviewSchema>;
export type SmsRoutePreview = z.infer<typeof SmsRoutePreviewSchema>;
export type SmsRouteImport = z.infer<typeof SmsRouteImportSchema>;
