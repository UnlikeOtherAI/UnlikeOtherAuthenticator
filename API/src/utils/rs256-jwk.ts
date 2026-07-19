import type { JWK } from 'jose';

type JsonObject = Record<string, unknown>;

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

function parseJsonObject(input: string): JsonObject | null {
  try {
    const value = JSON.parse(input) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  } catch {
    return null;
  }
}

export function parsePrivateRs256Jwk(input: string): { jwk: JWK; kid: string } | null {
  const key = parseJsonObject(input);
  if (
    key?.kty !== 'RSA' ||
    typeof key.kid !== 'string' ||
    key.kid.length < 1 ||
    typeof key.n !== 'string' ||
    key.n.length < 1 ||
    typeof key.e !== 'string' ||
    key.e.length < 1 ||
    typeof key.d !== 'string' ||
    key.d.length < 1 ||
    (key.alg !== undefined && key.alg !== 'RS256') ||
    (key.use !== undefined && key.use !== 'sig')
  ) {
    return null;
  }
  return { jwk: key as unknown as JWK, kid: key.kid };
}

export function privateRs256JwkKeyId(input: string): string | undefined {
  return parsePrivateRs256Jwk(input)?.kid;
}

export function publicRs256JwkKeyIds(input: string): string[] | undefined {
  const jwks = parseJsonObject(input);
  if (!Array.isArray(jwks?.keys) || jwks.keys.length < 1) return undefined;

  const ids: string[] = [];
  for (const value of jwks.keys) {
    const key = value as JsonObject | null;
    if (
      !key ||
      key.kty !== 'RSA' ||
      typeof key.kid !== 'string' ||
      key.kid.length < 1 ||
      typeof key.n !== 'string' ||
      key.n.length < 1 ||
      typeof key.e !== 'string' ||
      key.e.length < 1 ||
      PRIVATE_MEMBERS.some((member) => key[member] !== undefined) ||
      (key.alg !== undefined && key.alg !== 'RS256') ||
      (key.use !== undefined && key.use !== 'sig')
    ) {
      return undefined;
    }
    ids.push(key.kid);
  }

  return new Set(ids).size === ids.length ? ids : undefined;
}

export function toPublicRs256Jwk(privateJwk: JWK): JWK {
  return {
    kty: 'RSA',
    n: privateJwk.n,
    e: privateJwk.e,
    kid: privateJwk.kid,
    use: 'sig',
    alg: 'RS256',
  };
}
