export const JWK_FINGERPRINT_PREFIX = 'uoa_fp_';

export function displayJwkFingerprint(fingerprint: string | null): string | null {
  if (!fingerprint) return fingerprint;
  if (fingerprint.startsWith(JWK_FINGERPRINT_PREFIX)) return fingerprint;
  return `${JWK_FINGERPRINT_PREFIX}${fingerprint}`;
}
