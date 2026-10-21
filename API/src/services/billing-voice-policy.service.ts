import { z } from 'zod';
import { AppError } from '../utils/errors.js';

export const voicePolicySchema = z.object({
  version: z.string().min(1).max(80), accountSid: z.string().regex(/^AC[\da-fA-F]{32}$/),
  region: z.enum(['us1', 'ie1']), expiresAt: z.string().datetime(),
  markupBps: z.number().int().min(0).max(100000), billingIncrementSeconds: z.literal(60),
  minimumBilledSeconds: z.literal(60), maxDurationSeconds: z.number().int().min(1).max(14400),
  pricingEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  cutoffEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // This tranche can settle connectivity only. Enabling ancillary billed features requires a new receipt contract.
  featureProfile: z.literal('connectivity_only'), ancillaryCharges: z.literal('none'),
}).strict();
export type VoicePolicy = z.infer<typeof voicePolicySchema>;
export function configuredVoicePolicy(): VoicePolicy {
  try {
    const policy = voicePolicySchema.parse(JSON.parse(process.env.BILLING_VOICE_POLICY_JSON ?? '{}'));
    if (process.env.BILLING_VOICE_ENABLED !== 'true' || Date.parse(policy.expiresAt) <= Date.now()) throw new Error();
    return policy;
  } catch { throw new AppError('SERVICE_UNAVAILABLE', 503, 'BILLING_VOICE_EVIDENCE_UNAVAILABLE'); }
}
