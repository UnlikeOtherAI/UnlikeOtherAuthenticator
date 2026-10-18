import { credentialArtifactSource } from '../credential-artifact.service.js';
import { AppError } from '../../utils/errors.js';

export type PublicCredentialSource = { assuranceId?: string; authenticationEvidenceId?: string };
/** Only signature-verified payloads may enter here. A known proof version cannot lose its source. */
export function publicCredentialSource(payload: Record<string, unknown>): PublicCredentialSource {
  const source = credentialArtifactSource(payload, 'public');
  if (source.assuranceReference || ['sso', 'sso_recovery', 'recovery'].includes(source.method ?? '')) invalid();
  return { assuranceId: source.assuranceId, authenticationEvidenceId: source.authenticationEvidenceId };
}
function invalid(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'); }

export function publicCredentialTtl(seconds: number, expiresAt?: Date): number {
  const ttl = Math.min(seconds, expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 1000) : seconds);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) invalid();
  return ttl;
}
