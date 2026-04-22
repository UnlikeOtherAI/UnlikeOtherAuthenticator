import { describe, expect, it } from 'vitest';

import {
  computeJwkFingerprint,
  findJwkByKid,
  parsePublicRsaJwk,
  parsePublicRsaJwks,
} from '../../src/services/client-jwk.service.js';

const publicJwk = {
  kty: 'RSA',
  kid: 'partner-2026-04',
  alg: 'RS256',
  use: 'sig',
  n:
    '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6Bbq1B4N7yU5I9kNbGzrR1_IcpbhM0TbBTpxKfjvCT0e8VXUW1WPbSgpS2Mx7Zd8fX3h7uXXHYPtvDlJZ6JZPoz0lJj8t3Lb4',
  e: 'AQAB',
};

describe('client-jwk.service', () => {
  it('parses a public RSA JWK', () => {
    const parsed = parsePublicRsaJwk(publicJwk);
    expect(parsed.kid).toBe(publicJwk.kid);
  });

  it('rejects a JWK that carries private members', () => {
    expect(() => parsePublicRsaJwk({ ...publicJwk, d: 'secret' })).toThrow();
  });

  it('rejects a non-RSA JWK', () => {
    expect(() => parsePublicRsaJwk({ ...publicJwk, kty: 'EC' })).toThrow();
  });

  it('parses a JWKS with at least one key', () => {
    const jwks = parsePublicRsaJwks({ keys: [publicJwk] });
    expect(jwks.keys).toHaveLength(1);
  });

  it('rejects an empty JWKS', () => {
    expect(() => parsePublicRsaJwks({ keys: [] })).toThrow();
  });

  it('computes a deterministic SHA-256 fingerprint over canonical {e,kid,kty,n}', () => {
    const fingerprintA = computeJwkFingerprint(parsePublicRsaJwk(publicJwk));
    const fingerprintB = computeJwkFingerprint(parsePublicRsaJwk(publicJwk));
    expect(fingerprintA).toBe(fingerprintB);
    expect(fingerprintA).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('changes the fingerprint when the kid changes', () => {
    const base = parsePublicRsaJwk(publicJwk);
    const rotated = parsePublicRsaJwk({ ...publicJwk, kid: 'other-kid' });
    expect(computeJwkFingerprint(base)).not.toBe(computeJwkFingerprint(rotated));
  });

  it('finds a JWK by kid in a JWKS', () => {
    const jwks = parsePublicRsaJwks({ keys: [publicJwk] });
    expect(findJwkByKid(jwks, publicJwk.kid)?.kid).toBe(publicJwk.kid);
    expect(findJwkByKid(jwks, 'missing')).toBeNull();
  });
});
