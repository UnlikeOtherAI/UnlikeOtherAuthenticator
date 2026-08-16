import { type JWK, type KeyLike, SignJWT, createLocalJWKSet, importJWK, jwtVerify } from 'jose';

import { getEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import {
  parsePrivateRs256Jwk,
  parsePublicRs256Jwks,
  privateRs256JwkMatchesPublicJwks,
} from '../utils/rs256-jwk.js';

const ALGORITHM = 'RS256';

/**
 * The RS256 signer for the user access token relying parties receive.
 *
 * This exists because the default HS256 token is signed with `SHARED_SECRET`,
 * which is also the domain-hash secret, the refresh-token HMAC pepper, and the
 * signing key for the login_token / 2FA / social bridge tokens. Handing a
 * relying party the key to verify that token would hand it the key to mint one
 * for any user of any domain. The token is therefore unverifiable by design, not
 * by omission — the only fix is a signature the public half of which is safe to
 * publish.
 *
 * A dedicated key pair, not a reuse of the confidential resource-token signer:
 * the estate already keeps tariff snapshots and Ledger assertions on separate
 * trust surfaces, and a user session token is a third audience.
 */
type LoadedKey = {
  privateKey: KeyLike;
  kid: string;
  publicJwks: { keys: JWK[] };
};

let cachedKey: LoadedKey | undefined;

async function loadKey(): Promise<LoadedKey> {
  if (cachedKey) return cachedKey;
  const env = getEnv();
  const privateRaw = env.USER_ACCESS_TOKEN_PRIVATE_JWK;
  const publicRaw = env.USER_ACCESS_TOKEN_PUBLIC_JWKS_JSON;
  if (!privateRaw || !publicRaw) {
    throw new AppError('INTERNAL', 500, 'USER_ACCESS_TOKEN_SIGNING_DISABLED');
  }
  const parsedPrivate = parsePrivateRs256Jwk(privateRaw);
  const parsedPublic = parsePublicRs256Jwks(publicRaw);
  if (!parsedPrivate || !parsedPublic || !privateRs256JwkMatchesPublicJwks(privateRaw, publicRaw)) {
    throw new AppError('INTERNAL', 500, 'USER_ACCESS_TOKEN_KEY_INVALID');
  }
  try {
    const privateKey = (await importJWK(parsedPrivate.jwk, ALGORITHM)) as KeyLike;
    await Promise.all(parsedPublic.keys.map((key) => importJWK(key, ALGORITHM)));
    cachedKey = {
      privateKey,
      kid: parsedPrivate.kid,
      publicJwks: { keys: parsedPublic.keys },
    };
    return cachedKey;
  } catch {
    throw new AppError('INTERNAL', 500, 'USER_ACCESS_TOKEN_KEY_INVALID');
  }
}

export function resetUserAccessTokenKeyCache(): void {
  cachedKey = undefined;
}

export async function preloadUserAccessTokenSigningKey(): Promise<void> {
  await loadKey();
}

/** Current and retired verification keys, published so relying parties can check
 *  a signature instead of decoding and trusting. */
export async function getUserAccessTokenPublicJwks(): Promise<{ keys: JWK[] }> {
  const { keys } = (await loadKey()).publicJwks;
  return { keys: keys.map((key) => ({ ...key })) };
}

/**
 * Sign an access token RS256. Claims, `iss`, `aud`, `sub` and TTL are supplied by
 * the caller and are deliberately identical to the HS256 form — only the
 * signature and the `kid` header differ, so a relying party that already decodes
 * the token keeps working unchanged and one that starts verifying needs no other
 * change.
 */
export async function signUserAccessTokenRs256(params: {
  payload: Record<string, unknown>;
  issuer: string;
  audience: string;
  subject: string;
  ttl: string;
}): Promise<string> {
  const { privateKey, kid } = await loadKey();
  return new SignJWT(params.payload)
    .setProtectedHeader({ alg: ALGORITHM, kid, typ: 'JWT' })
    .setIssuer(params.issuer)
    .setAudience(params.audience)
    .setSubject(params.subject)
    .setIssuedAt()
    .setExpirationTime(params.ttl)
    .sign(privateKey);
}

/**
 * Verify an RS256 access token against the published set.
 *
 * The key material comes only from the JWKS and the algorithm list is pinned to
 * RS256, so a token whose header claims HS256 can never be verified here with a
 * public key, and the shared secret is never reachable from this path. That
 * separation is what keeps accepting two algorithms from becoming an
 * algorithm-confusion downgrade.
 */
export async function verifyUserAccessTokenRs256(
  token: string,
  options: { issuer: string; audience: string; clockTolerance: number },
): Promise<Record<string, unknown>> {
  const { publicJwks } = await loadKey();
  const jwks = createLocalJWKSet(publicJwks);
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: [ALGORITHM],
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance: options.clockTolerance,
  });
  return payload as Record<string, unknown>;
}
