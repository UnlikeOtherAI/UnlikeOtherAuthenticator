import { z } from 'zod';
import { AppError } from '../utils/errors.js';

const base = z.object({
  version: z.string().min(1).max(80), accountSid: z.string().regex(/^AC[\da-fA-F]{32}$/),
  region: z.enum(['us1', 'ie1']),
  // Legacy deployment field. A calendar deadline must not stop a standing telephone service.
  expiresAt: z.string().datetime().optional(),
  markupBps: z.number().int().min(0).max(100000), billingIncrementSeconds: z.literal(60),
  minimumBilledSeconds: z.literal(60), maxDurationSeconds: z.number().int().min(1).max(14400),
  pricingEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  cutoffEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const voicePolicySchema = z.discriminatedUnion('featureProfile', [
  base.extend({ featureProfile: z.literal('connectivity_only'), ancillaryCharges: z.literal('none') }).strict(),
  base.extend({ featureProfile: z.literal('media_streams_fixed'), ancillaryCharges: z.literal('fixed_rate'),
    streamPricePerMinute: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).max(40).refine(v => Number(v) > 0),
    streamDisclosureVersion: z.string().min(1).max(80),
    streamBillingBasis: z.literal('nessie_duration_rounded_minute'),
  }).strict(),
]);
export type VoicePolicy = z.infer<typeof voicePolicySchema>;
export function configuredVoicePolicy(): VoicePolicy {
  try {
    const policy = voicePolicySchema.parse(JSON.parse(process.env.BILLING_VOICE_POLICY_JSON ?? '{}'));
    if (process.env.BILLING_VOICE_ENABLED !== 'true') throw new Error();
    return policy;
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_VOICE_EVIDENCE_UNAVAILABLE'); }
}
