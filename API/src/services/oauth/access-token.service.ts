// RS256 access-token signing for the public-client / MCP OAuth profile (brief
// §22.14). These tokens are resource-bound (aud = the RFC 8707 `resource`) and are
// verified by resource servers via the published JWKS (GET /oauth/jwks.json) with no
// shared secret. This is deliberately separate from the HS256 client-domain access
// tokens (token.service.ts) and from config-JWT verification (§22.2).
import { type JWK, type KeyLike, SignJWT, importJWK } from 'jose';

import { getEnv } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import type { OrgContext } from '../org-context.service.js';

const ALG = 'RS256';

interface LoadedKey {
  privateKey: KeyLike;
  kid: string;
  publicJwk: JWK;
}

let cached: LoadedKey | undefined;

function parsePrivateJwk(): { jwk: JWK; kid: string } {
  const raw = getEnv().MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK;
  if (!raw) throw new AppError('INTERNAL', 500, 'MCP_OAUTH_DISABLED');
  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new AppError('INTERNAL', 500, 'MCP_OAUTH_KEY_INVALID');
  }
  // Need an RSA private key (has `d`, `n`, `e`) with a `kid` so the JWKS is resolvable.
  if (jwk.kty !== 'RSA' || !jwk.d || !jwk.kid || !jwk.n || !jwk.e) {
    throw new AppError('INTERNAL', 500, 'MCP_OAUTH_KEY_INVALID');
  }
  return { jwk, kid: jwk.kid };
}

/** Public half of the signing key: drop all private members, advertise sig/RS256.
 *  `n`/`e`/`kid` are guaranteed present by parsePrivateJwk. */
function toPublicJwk(priv: JWK): JWK {
  return { kty: 'RSA', n: priv.n, e: priv.e, kid: priv.kid, use: 'sig', alg: ALG };
}

async function load(): Promise<LoadedKey> {
  if (cached) return cached;
  const { jwk, kid } = parsePrivateJwk();
  const privateKey = (await importJWK(jwk, ALG)) as KeyLike;
  cached = { privateKey, kid, publicJwk: toPublicJwk(jwk) };
  return cached;
}

/** Reset the cached key (tests mutate env between cases). */
export function resetAccessTokenKeyCache(): void {
  cached = undefined;
}

/** The public JWKS served at GET /oauth/jwks.json (access-token keys only). */
export async function getAccessTokenPublicJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await load();
  return { keys: [publicJwk] };
}

export interface McpAccessTokenClaims {
  subject: string;
  email: string;
  domain: string;
  clientId: string;
  role: 'superuser' | 'user';
  /** RFC 8707 resource the token is bound to; becomes the `aud`. */
  resource: string;
  issuer: string;
  ttlSeconds: number;
  scope?: string;
  org?: OrgContext | null;
}

/** Sign a resource-bound RS256 access token for the public-client profile. */
export async function signMcpAccessToken(claims: McpAccessTokenClaims): Promise<string> {
  const { privateKey, kid } = await load();
  const payload: Record<string, unknown> = {
    email: claims.email,
    domain: claims.domain,
    client_id: claims.clientId,
    role: claims.role,
  };
  if (claims.scope) payload.scope = claims.scope;
  if (claims.org) payload.org = claims.org;

  try {
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: ALG, kid, typ: 'at+jwt' })
      .setIssuer(claims.issuer)
      .setAudience(claims.resource)
      .setSubject(claims.subject)
      .setIssuedAt()
      .setExpirationTime(`${claims.ttlSeconds}s`)
      .sign(privateKey);
  } catch {
    throw new AppError('INTERNAL', 500, 'TOKEN_SIGN_FAILED');
  }
}
