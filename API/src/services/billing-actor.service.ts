import { decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { AppError } from '../utils/errors.js';
import { importClientJwkKey, jwkToPublic } from './client-jwk.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';

export const BILLING_ACTOR_MAX_TTL_SECONDS = 60;
export const BILLING_ACTOR_CLOCK_TOLERANCE_SECONDS = 5;

const BillingActorSchema = z
  .object({
    iss: z.string().trim().min(1),
    aud: z.string().trim().min(1),
    sub: z.string().trim().min(1).max(256),
    product: z.string().trim().min(1).max(100),
    organisation_id: z.string().trim().min(1).max(256),
    team_id: z.string().trim().min(1).max(256),
    jti: z.string().trim().min(1).max(256),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .passthrough();

export type BillingActor = z.infer<typeof BillingActorSchema>;

export async function verifyBillingActor(
  params: {
    token: string;
    credential: VerifiedBillingAppKey;
    request: {
      product: string;
      organisationId: string;
      teamId: string;
      userId: string;
    };
  },
  deps?: { now?: () => number },
): Promise<BillingActor> {
  try {
    const header = decodeProtectedHeader(params.token);
    if (header.alg !== 'RS256' || header.kid !== params.credential.actorKeyId) {
      throw new Error('invalid actor header');
    }

    const publicKey = await importClientJwkKey(jwkToPublic(params.credential.actorPublicJwk));
    const { payload } = await jwtVerify(params.token, publicKey, {
      algorithms: ['RS256'],
      issuer: params.credential.actorIssuer,
      audience: params.credential.actorAudience,
      clockTolerance: BILLING_ACTOR_CLOCK_TOLERANCE_SECONDS,
    });
    const actor = BillingActorSchema.parse(payload);
    const now = deps?.now?.() ?? Math.floor(Date.now() / 1000);

    if (
      actor.exp <= actor.iat ||
      actor.exp - actor.iat > BILLING_ACTOR_MAX_TTL_SECONDS ||
      actor.iat > now + BILLING_ACTOR_CLOCK_TOLERANCE_SECONDS ||
      actor.product !== params.request.product ||
      actor.sub !== params.request.userId ||
      actor.organisation_id !== params.request.organisationId ||
      actor.team_id !== params.request.teamId
    ) {
      throw new Error('actor/request mismatch');
    }
    return actor;
  } catch {
    throw new AppError('UNAUTHORIZED', 401, 'INVALID_BILLING_ACTOR');
  }
}
