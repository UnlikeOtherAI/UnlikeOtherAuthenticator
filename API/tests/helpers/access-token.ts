import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';

import { ACCESS_TOKEN_AUDIENCE } from '../../src/config/constants.js';

/**
 * Verify an access token the way a caller must, whichever algorithm this
 * deployment signs with.
 *
 * Tests used to HMAC the token with `SHARED_SECRET` directly. That works only
 * while the token is HS256, and it is precisely the check a relying party can
 * never perform — the shared secret is also the domain-hash secret and the
 * refresh-token pepper. With `USER_ACCESS_TOKEN_*` configured the token is
 * RS256 and must be verified against the published JWKS instead, so the
 * assertion picks its branch from the protected header exactly as
 * `verifyAccessToken` does. This keeps the suite meaningful in both
 * configurations rather than pinning it to the legacy one.
 */
export async function verifyIssuedAccessToken(
  token: string,
  options: { issuer?: string; sharedSecret?: string } = {},
): Promise<JWTPayload> {
  const issuer = options.issuer ?? process.env.AUTH_SERVICE_IDENTIFIER;
  const audience = ACCESS_TOKEN_AUDIENCE;

  if (decodeProtectedHeader(token).alg === 'RS256') {
    const raw = process.env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON;
    if (!raw) throw new Error('RS256 access token but no published JWKS configured');
    const jwks = createLocalJWKSet(JSON.parse(raw) as Parameters<typeof createLocalJWKSet>[0]);
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer,
      audience,
    });
    return payload;
  }

  const secret = options.sharedSecret ?? process.env.SHARED_SECRET;
  if (!secret) throw new Error('SHARED_SECRET is required to verify an HS256 access token');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    issuer,
    audience,
  });
  return payload;
}
