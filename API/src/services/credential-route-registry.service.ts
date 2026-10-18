import type { Prisma, PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { requireProductAssurance } from './session-assurance.service.js';
import { requireAuthenticationEvidence } from './authentication-evidence.service.js';
import { assertOrgAccessPolicy } from './org-sso-policy.service.js';

/** The registry dispatches real authority checks; route labels never constitute evidence. */
export const credentialRouteRegistry = {
  configured_access: { authority: 'global', source: 'session' },
  organisation_access: { authority: 'org', source: 'session' },
  confidential_subject: { authority: 'org', source: 'session' },
  chained_subject: { authority: 'org', source: 'session' },
  billing_actor: { authority: 'org', source: 'session' },
  broker_source: { authority: 'org', source: 'session' },
  configured_authorization: { authority: 'continuation', source: 'evidence' },
  public_authorization: { authority: 'global', source: 'evidence' },
  login_chooser: { authority: 'continuation', source: 'evidence' },
  factor_challenge: { authority: 'continuation', source: 'evidence' },
  factor_enrollment: { authority: 'global', source: 'evidence' },
  signature_continuation: { authority: 'continuation', source: 'evidence' },
  public_access: { authority: 'global', source: 'either' },
  native_refresh: { authority: 'global', source: 'session' },
  kelpie_connect: { authority: 'global', source: 'either' },
  kelpie_pair: { authority: 'global', source: 'either' },
  global_action: { authority: 'global', source: 'session' },
  debug_source: { authority: 'continuation', source: 'session' },
} as const;
export type CredentialSurface = keyof typeof credentialRouteRegistry;
type Db = PrismaClient | Prisma.TransactionClient;
export type CredentialAuthorityInput = {
  userId: string; clientDomain: string; credentialEpoch: number; orgId?: string | null; teamId?: string | null;
  assuranceId?: string; assuranceReference?: string; authenticationEvidenceId?: string; method?: string;
  allowConsumedEvidence?: boolean;
};
function denied(): never { throw new AppError('FORBIDDEN', 403, 'INDEPENDENT_REAUTH_REQUIRED'); }

/** Invoke only after the artifact's signature/purpose/browser binding has been verified. */
export async function authorizeCredentialSurface(surface: CredentialSurface, input: CredentialAuthorityInput, db: Db) {
  const rule = credentialRouteRegistry[surface]; if (!rule) denied();
  const familySource = Boolean(input.assuranceId || input.assuranceReference);
  if ((familySource && input.authenticationEvidenceId) || (familySource && rule.source === 'evidence') ||
    (input.authenticationEvidenceId && rule.source === 'session')) denied();
  let source: { provenance: string; expiresAt: Date; orgId: string | null; teamId: string | null } | null = null;
  if (input.authenticationEvidenceId) {
    const proof = await requireAuthenticationEvidence({ id: input.authenticationEvidenceId, userId: input.userId,
      clientDomain: input.clientDomain, credentialEpoch: input.credentialEpoch, allowConsumed: input.allowConsumedEvidence }, db);
    if (proof.purpose !== 'authorize' || (input.method && input.method !== proof.method)) denied();
    source = proof;
  } else {
    const proof = await requireProductAssurance({ id: input.assuranceId, reference: input.assuranceReference,
      userId: input.userId, clientDomain: input.clientDomain, credentialEpoch: input.credentialEpoch,
      orgId: input.orgId, teamId: input.teamId }, db);
    if (proof) source = { ...proof, provenance: proof.method };
  }
  if (!source && ['sso', 'sso_recovery', 'recovery'].includes(input.method ?? '')) denied();
  if (source && rule.authority === 'global' && source.provenance !== 'independent') denied();
  if (source && source.provenance !== 'independent' && ((input.orgId && source.orgId !== input.orgId) ||
    (input.teamId && source.teamId && source.teamId !== input.teamId))) denied();
  if (rule.authority === 'org' && !input.orgId) denied();
  if (input.orgId && rule.authority !== 'global') await assertOrgAccessPolicy({ userId: input.userId,
    domain: input.clientDomain, orgId: input.orgId, assuranceId: input.assuranceId,
    authenticationEvidenceId: input.authenticationEvidenceId }, db);
  return source;
}

/** Signature-only boot mode cannot accept an artifact advertising known scoped provenance. */
export async function authorizeCredentialSurfaceWhenAvailable(surface: CredentialSurface, input: CredentialAuthorityInput) {
  if (getEnv().DATABASE_URL) return authorizeCredentialSurface(surface, input, getAdminPrisma());
  if (input.assuranceId || input.assuranceReference || input.authenticationEvidenceId ||
    ['sso', 'sso_recovery', 'recovery'].includes(input.method ?? '')) {
    throw new AppError('SERVICE_UNAVAILABLE', 503, 'ASSURANCE_STORE_REQUIRED');
  }
  return null;
}
