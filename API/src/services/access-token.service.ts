import { jwtVerify } from 'jose';
import { z } from 'zod';

import { requireEnv } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const ACCESS_TOKEN_ALLOWED_ALGS = ['HS256'] as const;

const AccessTokenClaimsSchema = z
  .object({
    email: z.string().trim().min(1),
    domain: z.string().trim().min(1),
    client_id: z.string().trim().min(1),
    role: z.enum(['superuser', 'user']),
  })
  .passthrough();

export type AccessTokenClaims = {
  userId: string;
  email: string;
  domain: string;
  clientId: string;
  role: 'superuser' | 'user';
};

function sharedSecretKey(sharedSecret: string): Uint8Array {
  return new TextEncoder().encode(sharedSecret);
}

export async function verifyAccessToken(
  token: string,
  deps?: { sharedSecret?: string; issuer?: string },
): Promise<AccessTokenClaims> {
  const { SHARED_SECRET, AUTH_SERVICE_IDENTIFIER } = requireEnv(
    'SHARED_SECRET',
    'AUTH_SERVICE_IDENTIFIER',
  );

  const sharedSecret = deps?.sharedSecret ?? SHARED_SECRET;
  const issuer = deps?.issuer ?? AUTH_SERVICE_IDENTIFIER;

  try {
    const { payload } = await jwtVerify(token, sharedSecretKey(sharedSecret), {
      algorithms: [...ACCESS_TOKEN_ALLOWED_ALGS],
      issuer,
    });

    const parsed = AccessTokenClaimsSchema.parse(payload);
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');

    return {
      userId,
      email: parsed.email,
      domain: parsed.domain,
      clientId: parsed.client_id,
      role: parsed.role,
    };
  } catch {
    // Normalize all verification/parsing failures into a generic, user-safe error.
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_ACCESS_TOKEN');
  }
}

