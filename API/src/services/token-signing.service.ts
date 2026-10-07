import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { ACCESS_TOKEN_AUDIENCE } from '../config/constants.js';
import { isUserAccessTokenRs256Enabled } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import type { OrgContext } from './org-context.service.js';
import { signUserAccessTokenRs256 } from './user-access-token-key.service.js';
type ActiveTeamClaim = { orgId: string; teamId: string; tenantSlug: string };

export async function signAccessToken(params: {
  userId: string;
  email: string;
  domain: string;
  role: 'superuser' | 'user';
  clientId: string;
  sharedSecret: string;
  ttl: string;
  issuer: string;
  tokenVersion: number;
  org?: OrgContext | null;
  active?: ActiveTeamClaim | null;
  /** False for the first-party admin domain, which signs with its own separate
   *  HS256 secret and is consumed only by UOA's own Admin panel — not a relying
   *  party, so it stays out of the publishable-signature surface. */
  relyingPartyToken: boolean;
}): Promise<string> {
  const payload = {
    ...(!params.relyingPartyToken ? { jti: randomUUID() } : {}),
    email: params.email,
    domain: params.domain,
    client_id: params.clientId,
    role: params.role,
    tv: params.tokenVersion,
  } as {
    email: string;
    domain: string;
    client_id: string;
    role: 'superuser' | 'user';
    tv: number;
    org?: OrgContext;
    active?: ActiveTeamClaim;
  };

  if (params.org) {
    payload.org = params.org;
  }

  if (params.active) {
    payload.active = params.active;
  }

  try {
    // Same claims, same iss/aud/sub, same TTL either way — only the signature and
    // the kid header change, so this is a drop-in for every existing consumer.
    if (params.relyingPartyToken && isUserAccessTokenRs256Enabled()) {
      return await signUserAccessTokenRs256({
        payload,
        issuer: params.issuer,
        audience: ACCESS_TOKEN_AUDIENCE,
        subject: params.userId,
        ttl: params.ttl,
      });
    }
    return await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(params.issuer)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setSubject(params.userId)
      .setIssuedAt()
      .setExpirationTime(params.ttl)
      .sign(new TextEncoder().encode(params.sharedSecret));
  } catch {
    throw new AppError('INTERNAL', 500, 'TOKEN_SIGN_FAILED');
  }
}
