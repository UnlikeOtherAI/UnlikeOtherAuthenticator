import type { IssuedTokenPair } from '../../services/token.service.js';

/** Confidential session responses retain the original proof issued with the pair. */
export function tokenPairResponse(pair: IssuedTokenPair): Record<string, unknown> {
  return {
    access_token: pair.accessToken,
    expires_in: pair.expiresInSeconds,
    refresh_token: pair.refreshToken,
    refresh_token_expires_in: pair.refreshTokenExpiresInSeconds,
    token_type: 'Bearer',
    ...(pair.assuranceRef ? { assurance_ref: pair.assuranceRef,
      assurance_expires_at: pair.assuranceExpiresAt } : {}),
    ...(pair.firstLogin ? { firstLogin: pair.firstLogin } : {}),
  };
}
