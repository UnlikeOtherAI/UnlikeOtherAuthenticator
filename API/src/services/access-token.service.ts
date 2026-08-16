import type { PrismaClient } from '@prisma/client';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { ACCESS_TOKEN_AUDIENCE } from '../config/constants.js';
import {
  getAuthServiceIdentifier,
  getEnv,
  isUserAccessTokenRs256Enabled,
  requireEnv,
} from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { verifyUserAccessTokenRs256 } from './user-access-token-key.service.js';

// Both are accepted for the whole transition, and neither can stand in for the
// other: the branch is chosen by the protected header and each branch pins its
// own single algorithm and its own key material. HS256 is only ever verified
// with the shared secret and RS256 only ever against the published JWKS, so a
// token cannot be downgraded from one to the other.
const ACCESS_TOKEN_ALLOWED_ALGS = ['HS256'] as const;
const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

const AccessTokenClaimsSchema = z
  .object({
    email: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    client_id: z.string().trim().min(1),
    role: z.enum(['superuser', 'user']),
    // Staged rollout: pre-epoch HS256 tokens may omit tv only while the live
    // user epoch remains zero. Every new UOA token includes this claim.
    tv: z.number().int().nonnegative().optional(),
    org: z
      .object({
        org_id: z.string().trim().min(1),
        tenant_slug: z.string().trim().min(1).optional(),
        org_role: z.string().trim().min(1),
        teams: z.array(z.string().trim().min(1)),
        team_roles: z.record(z.string().trim().min(1), z.string().trim().min(1)),
        groups: z.array(z.string().trim().min(1)).optional(),
        group_admin: z.array(z.string().trim().min(1)).optional(),
      })
      .passthrough()
      .optional(),
    // Slack-style workspace-scoped sessions (design §7 step 3-4), populated by explicit selection
    // or an unambiguous server-side auto-selection.
    active: z
      .object({
        orgId: z.string().trim().min(1),
        teamId: z.string().trim().min(1),
        // Added for tenant-aware clients. Older, already-issued tokens do not
        // carry it and remain valid until expiry.
        tenantSlug: z.string().trim().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AccessTokenClaims = {
  userId: string;
  tokenVersion: number;
  email: string;
  domain: string;
  clientId: string;
  role: 'superuser' | 'user';
  org?: {
    org_id: string;
    tenant_slug?: string;
    org_role: string;
    teams: string[];
    team_roles: Record<string, string>;
    groups?: string[];
    group_admin?: string[];
  };
  active?: {
    orgId: string;
    teamId: string;
    tenantSlug?: string;
  };
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

type AccessTokenPrisma = Pick<PrismaClient, 'user'>;

/**
 * Verify the signature and the registered claims, choosing the branch from the
 * protected header.
 *
 * RS256 is accepted only while this deployment publishes a verification key, and
 * is verified only against that published set — never with the shared secret.
 * HS256 keeps its existing single-algorithm pin. An `alg` that is neither, or
 * RS256 on a deployment that publishes no key, fails here and is normalised to
 * the generic error by the caller.
 */
async function verifySignature(
  token: string,
  params: { sharedSecret: string; issuer: string },
): Promise<Record<string, unknown>> {
  const header = decodeProtectedHeader(token);
  if (header.alg === 'RS256') {
    if (!isUserAccessTokenRs256Enabled()) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
    }
    return verifyUserAccessTokenRs256(token, {
      issuer: params.issuer,
      audience: ACCESS_TOKEN_AUDIENCE,
      clockTolerance: ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
    });
  }

  const { payload } = await jwtVerify(token, sharedSecretKey(params.sharedSecret), {
    algorithms: [...ACCESS_TOKEN_ALLOWED_ALGS],
    issuer: params.issuer,
    audience: ACCESS_TOKEN_AUDIENCE,
    // Parity with config.service.ts and auto-onboarding.service.ts: allow a tiny
    // amount of clock skew between client/server. 30 seconds keeps the token still
    // short-lived while preventing brittle "barely-expired" rejections.
    clockTolerance: ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
  });
  return payload as Record<string, unknown>;
}

export async function verifyAccessToken(
  token: string,
  deps?: { sharedSecret?: string; issuer?: string; prisma?: AccessTokenPrisma },
): Promise<AccessTokenClaims> {
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

  const sharedSecret = deps?.sharedSecret ?? SHARED_SECRET;
  const issuer = deps?.issuer ?? getAuthServiceIdentifier();
  // Access-token verification runs before tenant context exists. Use the
  // BYPASSRLS client by default so a valid user never looks absent under FORCE
  // RLS. DB-less/boot mode has no users table, so the lookup is skipped.
  const prisma =
    deps?.prisma ??
    (getEnv().DATABASE_URL ? (getAdminPrisma() as unknown as AccessTokenPrisma) : undefined);

  let parsed: z.infer<typeof AccessTokenClaimsSchema>;
  let userId: string;
  try {
    const payload = await verifySignature(token, { sharedSecret, issuer });

    parsed = AccessTokenClaimsSchema.parse(payload);
    userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  } catch {
    // Normalize all verification/parsing failures into a generic, user-safe error.
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  }

  // Stateless JWTs survive logout/credential changes by signature+exp alone.
  // Cross-check the per-user token version so revocation events invalidate
  // already-issued access tokens. Only a missing user or version mismatch is
  // an authentication failure; unexpected DB failures must remain observable
  // as 5xx so clients do not erase otherwise-valid sessions during outages.
  const credentialEpoch = parsed.tv ?? 0;
  if (prisma) {
    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    if (!current || current.tokenVersion !== credentialEpoch) {
      throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
    }
  } else if (parsed.tv === undefined) {
    // Missing-tv compatibility is never an offline signature-only bypass.
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  }

  return {
    userId,
    tokenVersion: credentialEpoch,
    email: parsed.email,
    domain: parsed.domain,
    clientId: parsed.client_id,
    role: parsed.role,
    ...(parsed.org ? { org: parsed.org } : {}),
    ...(parsed.active ? { active: parsed.active } : {}),
  };
}
