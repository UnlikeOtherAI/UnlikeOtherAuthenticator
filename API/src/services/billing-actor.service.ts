import type { Prisma, PrismaClient } from '@prisma/client';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

import { AppError } from '../utils/errors.js';
import { ORGANISATION_FINANCIAL_ENDPOINTS } from './billing-financial-endpoints.service.js';
import { requireBillingManager } from './billing-financial-authority.service.js';
import { getAdminPrisma } from '../db/prisma.js';
import { financialAssuranceCustodyTeam } from './billing-financial-assurance.service.js';
import { importClientJwkKey, jwkToPublic } from './client-jwk.service.js';
import {
  assertBillingActorAudience,
  logLegacyBillingActorAudience,
  type BillingActorEndpoint,
} from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { credentialArtifactSource } from './credential-artifact.service.js';
import { authorizeCredentialSurfaceWhenAvailable } from './credential-route-registry.service.js';

export const BILLING_ACTOR_MAX_TTL_SECONDS = 60;
export const BILLING_ACTOR_CLOCK_TOLERANCE_SECONDS = 5;

const BillingActorSchema = z
  .object({
    iss: z.string().trim().min(1),
    aud: z.string().trim().min(1),
    sub: z.string().trim().min(1).max(256),
    product: z.string().trim().min(1).max(100),
    organisation_id: z.string().trim().min(1).max(256),
    team_id: z.string().trim().min(1).max(256).nullable(),
    financial_scope: z.literal('organisation').optional(),
    tv: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    assurance_ref: z.string().min(32).max(256).optional(),
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
    /** The exact billing endpoint this assertion was presented to. Its audience must
     *  name it; see billing-actor-audience.service.ts. */
    endpoint: BillingActorEndpoint;
    request: {
      product: string;
      organisationId: string;
      teamId: string | null;
      userId: string;
    };
  },
  deps?: { now?: () => number; prisma?: PrismaClient | Prisma.TransactionClient },
): Promise<BillingActor> {
  const actor = await verifyBillingActorSignature(params, deps);
  if(actor.financial_scope==='organisation'&&!ORGANISATION_FINANCIAL_ENDPOINTS.has(params.endpoint)) {
    throw new AppError('UNAUTHORIZED',401,'INVALID_BILLING_ACTOR');
  }

  if (actor.team_id === null) {
    if (actor.financial_scope !== 'organisation' || !ORGANISATION_FINANCIAL_ENDPOINTS.has(params.endpoint)) {
      throw new AppError('UNAUTHORIZED',401,'INVALID_BILLING_ACTOR');
    }
    await requireBillingManager(params.request, deps?.prisma as PrismaClient | undefined);
    const user = await (deps?.prisma ?? getAdminPrisma()).user.findFirst({where:{id:actor.sub,
      lifecycleStatus:'ACTIVE',tokenVersion:actor.tv},select:{id:true}});
    if (!user) throw new AppError('FORBIDDEN',403,'BILLING_SUBJECT_NOT_ENTITLED');
  }

  // Audience is checked after the signature so an unauthenticated caller learns
  // nothing, and outside the catch-all below so a mismatch keeps its own code.
  const outcome = assertBillingActorAudience({
    presented: actor.aud,
    endpoint: params.endpoint,
    legacyAudience: params.credential.actorAudience,
  });
  if (outcome === 'legacy') {
    if(actor.financial_scope==='organisation') {
      throw new AppError('UNAUTHORIZED',401,'BILLING_ACTOR_AUDIENCE_MISMATCH');
    }
    logLegacyBillingActorAudience({
      endpoint: params.endpoint,
      presented: actor.aud,
      product: actor.product,
      appKeyId: params.credential.id,
    });
  }
  {
    const issuer = new URL(params.credential.actorIssuer);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new AppError('FORBIDDEN', 403, 'INVALID_BILLING_ACTOR');
    }
    const clientDomain = issuer.hostname + (issuer.pathname === '/' ? '' : issuer.pathname);
    const artifact = credentialArtifactSource(actor, 'reference');
    const custodyTeam=actor.team_id===null && actor.assurance_ref ? await financialAssuranceCustodyTeam({
      reference:actor.assurance_ref,userId:actor.sub,organisationId:actor.organisation_id,
      clientDomain,credentialEpoch:actor.tv},deps?.prisma??getAdminPrisma()) : actor.team_id;
    await authorizeCredentialSurfaceWhenAvailable('billing_actor', { artifact, method: artifact.method,
      assuranceReference: actor.assurance_ref, clientDomain, userId: actor.sub,
      credentialEpoch: actor.tv, orgId: actor.organisation_id,
      teamId:custodyTeam }, deps?.prisma);
  }
  return actor;
}

async function verifyBillingActorSignature(
  params: {
    token: string;
    credential: VerifiedBillingAppKey;
    request: {
      product: string;
      organisationId: string;
      teamId: string | null;
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
    // `audience` is deliberately not delegated to jose: the acceptable audience is
    // per-endpoint and mode-dependent, and a mismatch must be distinguishable.
    const { payload } = await jwtVerify(params.token, publicKey, {
      algorithms: ['RS256'],
      issuer: params.credential.actorIssuer,
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
