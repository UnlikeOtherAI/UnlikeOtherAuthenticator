import { AppError } from '../utils/errors.js';

export type CredentialArtifactSource = {
  assuranceId?: string; assuranceReference?: string; authenticationEvidenceId?: string;
  version?: 1; method?: string; connectionId?: string | null;
};
function invalid(): never { throw new AppError('UNAUTHORIZED', 401, 'INVALID_CREDENTIAL_ARTIFACT'); }

/** Run only after signature, token class, issuer and audience verification. */
export function credentialArtifactSource(payload: Record<string, unknown>, kind: 'session' | 'reference' | 'evidence' | 'public') {
  const identifier = (value: unknown): string | undefined => value === undefined ? undefined :
    typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : invalid();
  const source: CredentialArtifactSource = { assuranceId: identifier(payload.assurance_id),
    assuranceReference: identifier(payload.assurance_ref), authenticationEvidenceId: identifier(payload.authentication_evidence_id) };
  if ((kind !== 'reference' && source.assuranceReference) ||
    (!['evidence', 'public'].includes(kind) && source.authenticationEvidenceId) ||
    (kind === 'evidence' && source.assuranceId) || (source.assuranceId && source.authenticationEvidenceId) ||
    (source.assuranceReference && source.authenticationEvidenceId) ||
    (kind === 'reference' && source.assuranceId && !source.assuranceReference)) invalid();
  if (payload.assurance_version !== undefined) {
    if (payload.assurance_version !== 1 || !(source.assuranceId || source.assuranceReference || source.authenticationEvidenceId)) invalid();
    source.version = 1;
  }
  if (payload.auth_method !== undefined || payload.assurance_method !== undefined) {
    const method = payload.auth_method ?? payload.assurance_method;
    if (typeof method !== 'string' || !method || method.length > 32 ||
      (payload.auth_method !== undefined && payload.assurance_method !== undefined && payload.auth_method !== payload.assurance_method)) invalid();
    source.method = method;
  }
  if (payload.assurance_connection_id !== undefined) source.connectionId = payload.assurance_connection_id === null
    ? null : identifier(payload.assurance_connection_id);
  if ((source.connectionId !== undefined || ['sso', 'sso_recovery', 'recovery'].includes(source.method ?? '')) &&
    !(source.assuranceId || source.assuranceReference || source.authenticationEvidenceId)) invalid();
  return source;
}

/** Signed metadata cannot contradict the original authoritative proof. */
export function assertCredentialArtifactProof(artifact: CredentialArtifactSource, proof: {
  id: string; provenance: string; method: string; connectionId: string | null; amr: string[];
} | null) {
  if (!proof) {
    if (artifact.assuranceId || artifact.assuranceReference || artifact.authenticationEvidenceId || artifact.version) invalid();
    return;
  }
  if ((artifact.assuranceId && artifact.assuranceId !== proof.id) ||
    (artifact.authenticationEvidenceId && artifact.authenticationEvidenceId !== proof.id) ||
    (artifact.connectionId !== undefined && artifact.connectionId !== proof.connectionId)) invalid();
  const method = artifact.method === 'sso_recovery' ? 'recovery' : artifact.method;
  if (proof.provenance !== 'independent') {
    if (method && method !== proof.provenance) invalid();
  } else if (method && (['sso', 'recovery'].includes(method) ||
    (method !== 'independent' && method !== proof.method && !proof.amr.includes(method)))) invalid();
}
