import { z } from 'zod';

export const MACHINE_CAPABILITY = 'machine_enrollment_v1';
export const MACHINE_VERSION = 1;
export const MACHINE_RECHECK_MS = 30_000;
export const MACHINE_PULL_MS = 15_000;
export const MACHINE_REPLAY_MS = 120_000;
export const MACHINE_CHALLENGE_MS = 300_000;
export const MACHINE_CONSENT_MS = 600_000;
export const MACHINE_CREDENTIAL_MS = 30 * 86_400_000;
export const MACHINE_AUTHORIZATION_MS = 365 * 86_400_000;

export const MachineSourceVersion = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n)
  .describe('Canonical positive decimal int64, maximum 9223372036854775807; compare losslessly, never Number or lexicographically.');
export const MachineGeneration = z.number().int().positive().max(2147483647);
// eslint-disable-next-line no-control-regex -- Opaque references must exclude control characters.
const id = z.string().min(1).max(100).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value));
export const MachinePublicKey = z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/) }).strict();
export const MachineBinding = z.object({ subject: id, audience: z.string().url().max(300),
  organization_id: id, team_id: id, purpose: z.literal('computer_connection'),
  binding_id: id.describe('Product-owned authorization binding ID; separate from stable Computer installation, connection/Executor and host/resource IDs. Terminal retirement requires a new grant and binding with explicit continuity/adoption, preserving those product references.') }).strict();
export type MachineBindingInput = z.infer<typeof MachineBinding>;
export const MachineRequestInput = MachineBinding.extend({ request_id: z.uuid(),
  device_name: z.string().trim().min(1).max(100), public_key: MachinePublicKey,
  enrollment_id: z.uuid().optional(),
  legacy_assurance_id: id.optional(),
}).strict();
export const MachineProof = z.object({ challenge_id: z.uuid(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/) }).strict();
export const MachineOperationInput = MachineBinding.extend({ request_id: z.uuid(),
  enrollment_id: z.uuid(), authorization_id: z.uuid(),
  credential_generation: MachineGeneration, source_version: MachineSourceVersion,
  credential: z.string().regex(/^uoa_machine_[A-Za-z0-9_-]{43}$/),
}).strict();
export const MachineChallengeInput = z.object({ operation: z.enum(['validate', 'rotate', 'revoke']),
  request: MachineOperationInput }).strict();
export const MachineOperationWithProof = MachineOperationInput.extend({ proof: MachineProof }).strict();
export type MachineOperation = z.infer<typeof MachineOperationInput>;
export type MachineOperationKind = z.infer<typeof MachineChallengeInput>['operation'];
export const MachineRecoveryInput = MachineBinding.extend({ request_id: z.uuid(), operation_id: z.uuid() }).strict();
export const MachineReason = z.enum(['active', 'authorization_expired', 'inactive', 'security_reset',
  'device_revoked', 'all_devices_revoked', 'credential_replay', 'lineage_invalid',
  'account_unavailable', 'product_disabled', 'access_removed', 'sso_policy_changed',
  'authentication_policy_changed', 'credential_expired', 'authority_unavailable']);
export type MachineReasonCode = z.infer<typeof MachineReason>;
export const MachineDecision = z.enum(['allowed', 'reauthorization_required', 'revoked', 'access_removed', 'unavailable']);
export const MachineUnavailableOutcome = z.object({ decision: z.literal('unavailable'),
  reason: z.literal('authority_unavailable') }).strict();
const decisionFields = z.object({ version: z.literal(1), capability: z.literal(MACHINE_CAPABILITY),
  original_grant_id: z.uuid(), authorization_id: z.uuid(), credential_generation: MachineGeneration,
  source_version: MachineSourceVersion, client_domain: id,
  binding: MachineBinding, key_thumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issued_at: z.iso.datetime(), recheck_by: z.iso.datetime(), authorization_expires_at: z.iso.datetime(),
}).strict();
export const MachineDecisionResponse = z.discriminatedUnion('decision', [
  decisionFields.extend({ decision: z.literal('allowed'), reason: z.literal('active') }).strict(),
  decisionFields.extend({ decision: z.literal('reauthorization_required'), reason: z.enum([
    'authorization_expired', 'inactive', 'sso_policy_changed', 'authentication_policy_changed', 'credential_expired']) }).strict(),
  decisionFields.extend({ decision: z.literal('revoked'), reason: z.enum(['security_reset', 'device_revoked',
    'all_devices_revoked', 'credential_replay', 'lineage_invalid', 'account_unavailable', 'product_disabled']) }).strict(),
  decisionFields.extend({ decision: z.literal('access_removed'), reason: z.literal('access_removed') }).strict(),
]).superRefine((value, context) => {
  const lifetime = Date.parse(value.recheck_by) - Date.parse(value.issued_at);
  if (value.decision === 'allowed' ? lifetime <= 0 || lifetime > MACHINE_RECHECK_MS ||
    Date.parse(value.recheck_by) > Date.parse(value.authorization_expires_at) : lifetime !== 0) {
    context.addIssue({ code: 'custom', message: 'Invalid machine authority deadline' });
  }
});
export const MachineTranscriptFields = z.object({ version: z.literal(1), issuer: z.string().url(), client_domain: id,
  operation: z.enum(['authorize', 'validate', 'rotate', 'revoke', 'recover']), request_id: z.uuid(),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/), challenge_id: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expires_at: z.iso.datetime() }).strict();
export const MachineRecoveryResponse = z.discriminatedUnion('outcome', [
  z.object({ version: z.literal(1), outcome: z.literal('recovered'), original_grant_id: z.uuid(), authorization_id: z.uuid(),
    credential_generation: MachineGeneration, source_version: MachineSourceVersion,
    credential: MachineOperationInput.shape.credential, credential_expires_at: z.iso.datetime(),
    authorization_expires_at: z.iso.datetime(), fresh_validation_required: z.literal(true) }).strict(),
  z.object({ version: z.literal(1), outcome: z.literal('denied'), decision: MachineDecisionResponse }).strict(),
  z.object({ version: z.literal(1), outcome: z.enum(['pending', 'not_committed']) }).strict(),
]);

export const machineCapabilities = {
  version: 1, capability: MACHINE_CAPABILITY, minimum_consumer_version: 1,
  purpose: 'computer_connection', product: 'nessie', algorithm: 'Ed25519',
  max_decision_seconds: 30, max_pull_interval_seconds: 15, challenge_seconds: 300,
  rotation_replay_seconds: 120, credential_seconds: 2592000, inactivity_seconds: 2592000,
  max_authorization_seconds: 31536000, source_version: 'canonical decimal bigint',
  source_version_max: '9223372036854775807', credential_generation_max: 2147483647,
  proof_profile: 'UOA-MACHINE-POP-V1/RFC8785-bounded',
  recovery_first_after_ambiguity: true, recovery_authorizes_work: false,
  key_replacement: 'fresh human authorization only', unavailable_is_denial: false,
  family_logout_revokes_machines: false, global_credential_epoch_revokes_machines: true,
  schema: '/schemas/machine-enrollment-v1.json',
} as const;
