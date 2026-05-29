import type { PrismaClient } from '@prisma/client';
import { jwtVerify } from 'jose';
import { z } from 'zod';

import { ACCESS_TOKEN_AUDIENCE } from '../config/constants.js';
import { getAuthServiceIdentifier, getEnv, requireEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';

const ACCESS_TOKEN_ALLOWED_ALGS = ['HS256'] as const;

const AccessTokenClaimsSchema = z
  .object({
    email: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    client_id: z.string().trim().min(1),
    role: z.enum(['superuser', 'user']),
    tv: z.number().int().nonnegative(),
    org: z
      .object({
        org_id: z.string().trim().min(1),
        org_role: z.string().trim().min(1),
        teams: z.array(z.string().trim().min(1)),
        team_roles: z.record(z.string().trim().min(1), z.string().trim().min(1)),
        groups: z.array(z.string().trim().min(1)).optional(),
        group_admin: z.array(z.string().trim().min(1)).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AccessTokenClaims = {
  userId: string;
  email: string;
  domain: string;
  clientId: string;
  role: 'superuser' | 'user';
  org?: {
    org_id: string;
    org_role: string;
    teams: string[];
    team_roles: Record<string, string>;
    groups?: string[];
    group_admin?: string[];
  };
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

type AccessTokenPrisma = Pick<PrismaClient, 'user'>;

export async function verifyAccessToken(
  token: string,
  deps?: { sharedSecret?: string; issuer?: string; prisma?: AccessTokenPrisma },
): Promise<AccessTokenClaims> {
  const { SHARED_SECRET } = requireEnv('SHARED_SECRET');

  const sharedSecret = deps?.sharedSecret ?? SHARED_SECRET;
  const issuer = deps?.issuer ?? getAuthServiceIdentifier();
  // Resolve the prisma client used for the token-version revocation lookup.
  // An explicit dep always wins (tests, admin-superuser passing the admin client).
  // Otherwise the default tenant client is used, but only when a database is
  // configured — DB-less/boot mode has no users table to check, so revocation
  // simply cannot apply and the lookup is skipped.
  const prisma =
    deps?.prisma ??
    (getEnv().DATABASE_URL ? (getPrisma() as unknown as AccessTokenPrisma) : undefined);

  try {
    const { payload } = await jwtVerify(token, sharedSecretKey(sharedSecret), {
      algorithms: [...ACCESS_TOKEN_ALLOWED_ALGS],
      issuer,
      audience: ACCESS_TOKEN_AUDIENCE,
      // Parity with config.service.ts and auto-onboarding.service.ts: allow a tiny
      // amount of clock skew between client/server. 30 seconds keeps the token still
      // short-lived while preventing brittle "barely-expired" rejections.
      clockTolerance: 30,
    });

    const parsed = AccessTokenClaimsSchema.parse(payload);
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');

    // Stateless JWTs survive logout/credential changes by signature+exp alone.
    // Cross-check the per-user token version so revocation events (logout,
    // password/2FA reset) invalidate already-issued access tokens. This DB
    // lookup is the intended cost of revocable sessions.
    if (prisma) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { tokenVersion: true },
      });
      if (!current || current.tokenVersion !== parsed.tv) {
        throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
      }
    }

    return {
      userId,
      email: parsed.email,
      domain: parsed.domain,
      clientId: parsed.client_id,
      role: parsed.role,
      ...(parsed.org ? { org: parsed.org } : {}),
    };
  } catch {
    // Normalize all verification/parsing failures into a generic, user-safe error.
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  }
}
