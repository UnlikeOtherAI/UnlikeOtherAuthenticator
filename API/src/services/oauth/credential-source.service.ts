import { AppError } from '../../utils/errors.js';

export type PublicCredentialSource = { assuranceId?: string; authenticationEvidenceId?: string };
/** Only signature-verified payloads may enter here. A known proof version cannot lose its source. */
export function publicCredentialSource(payload: Record<string, unknown>): PublicCredentialSource {
  const id = (value: unknown) => value === undefined ? undefined :
    typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : invalid();
  const source = { assuranceId: id(payload.assurance_id), authenticationEvidenceId: id(payload.authentication_evidence_id) };
  if ((source.assuranceId && source.authenticationEvidenceId) ||
    (payload.assurance_version !== undefined && payload.assurance_version !== 1) ||
    (payload.assurance_version === 1 && !source.assuranceId && !source.authenticationEvidenceId) ||
    ['sso', 'sso_recovery', 'recovery'].includes(String(payload.auth_method ?? ''))) invalid();
  return source;
}
function invalid(): never { throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED'); }

export function publicCredentialTtl(seconds: number, expiresAt?: Date): number {
  const ttl = Math.min(seconds, expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 1000) : seconds);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) invalid();
  return ttl;
}
