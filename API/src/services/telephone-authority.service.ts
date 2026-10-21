import { BillingAppKeyPurpose, Prisma, type PrismaClient } from '@prisma/client';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { getEnv, getPublicBaseUrl } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { verifyBillingActor } from './billing-actor.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { billingActorAudience, type BillingActorEndpoint } from './billing-actor-audience.service.js';
import { importClientJwkKey, jwkToPublic } from './client-jwk.service.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';

export const TelephoneNumber = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
export const TelephoneVisibility = z.enum(['private', 'team']);
export const LOOKUP_PATH = '/apps/v1/nessie/phone-profile/lookup';
export type TelephoneSubject = { product: string; organisationId: string; teamId: string; userId: string };
export type TelephoneAuth = { credential: VerifiedBillingAppKey; actorToken: string; request: TelephoneSubject };
export const telephoneDigest = (value: string): string =>
  createHmac('sha256', getEnv().SHARED_SECRET).update(`telephone:v1:${value}`).digest('hex');
export const telephoneDenied = () => new AppError('FORBIDDEN', 403);

export function assertTelephoneProduct(credential: VerifiedBillingAppKey): void {
  if (credential.service.identifier !== 'nessie' || credential.purpose !== BillingAppKeyPurpose.CUSTOMER_LIFECYCLE) {
    throw telephoneDenied();
  }
}
export async function lockTelephoneKey(tx: PrismaClient, credential: VerifiedBillingAppKey): Promise<void> {
  assertTelephoneProduct(credential);
  await lockProductTeamPolicyShared(tx);
  const key = await tx.billingAppKey.findFirst({ where: {
    id: credential.id, actorIssuer: credential.actorIssuer, actorKeyId: credential.actorKeyId,
    purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE, revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    service: { id: credential.service.id, identifier: 'nessie', active: true },
  }, select: { id: true } });
  if (!key) throw telephoneDenied();
}
export async function verifyTelephoneActor(input: TelephoneAuth, endpoint: BillingActorEndpoint) {
  assertTelephoneProduct(input.credential);
  if (input.request.product !== 'nessie') throw telephoneDenied();
  const actor = await verifyBillingActor({ token: input.actorToken, credential: input.credential, request: input.request, endpoint });
  if (actor.aud !== billingActorAudience(endpoint)) throw telephoneDenied();
  return actor;
}
export async function lockTelephoneSubject(tx: PrismaClient, input: TelephoneAuth, exp: number, tv: number): Promise<void> {
  await lockTelephoneKey(tx, input.credential);
  await lockAndAssertGlobalAuthenticationEpoch({ userId: input.request.userId, credentialEpoch: tv }, { prisma: tx });
  if (exp <= Math.floor(Date.now() / 1000)) throw telephoneDenied();
  const membership = await tx.orgMember.findFirst({ where: {
    userId: input.request.userId, orgId: input.request.organisationId, status: 'ACTIVE',
    org: { lifecycleStatus: 'ACTIVE', teams: { some: { id: input.request.teamId, lifecycleStatus: 'ACTIVE',
      members: { some: { userId: input.request.userId, status: 'ACTIVE' } } } } },
  }, select: { id: true } });
  if (!membership) throw telephoneDenied();
}
export async function telephoneLock(tx: PrismaClient, key: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`telephone:${key}`}, 0))::text`);
}

const LookupAssertion = z.object({
  iss: z.string(), aud: z.string(), purpose: z.enum(['telephone-routing', 'telephone-call-proof']), product: z.literal('nessie'),
  organisation_id: z.string().min(1).max(256), team_id: z.string().min(1).max(256),
  owner_subject: z.string().min(1).max(256).optional(),
  call_id: z.string().min(1).max(128), number_digest: z.string().regex(/^[a-f0-9]{64}$/),
  jti: z.string().min(1).max(128), iat: z.number().int(), exp: z.number().int(),
}).strict();
/** No human subject, epoch or authentication result: this is a backend routing request. */
async function verifyServiceAssertion<T extends { purpose: string; iat: number; exp: number }>(
  credential: VerifiedBillingAppKey, token: string, endpoint: string, purpose: string, schema: z.ZodType<T>) {
  assertTelephoneProduct(credential);
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'RS256' || header.kid !== credential.actorKeyId || header.typ !== `uoa-${purpose}+jwt`) throw telephoneDenied();
    const { payload } = await jwtVerify(token, await importClientJwkKey(jwkToPublic(credential.actorPublicJwk)), {
      algorithms: ['RS256'], issuer: credential.actorIssuer, audience: `${getPublicBaseUrl()}${endpoint}`,
    });
    const result = schema.parse(payload);
    const now = Math.floor(Date.now() / 1000);
    if (result.purpose !== purpose) throw telephoneDenied();
    if (result.exp <= result.iat || result.exp - result.iat > 60 || result.iat > now + 5) throw telephoneDenied();
    return result;
  } catch { throw telephoneDenied(); }
}

export const verifyTelephoneLookupAssertion = (credential: VerifiedBillingAppKey, token: string) =>
  verifyTelephoneServiceAssertion(credential, token, LOOKUP_PATH, 'telephone-routing');

export const verifyTelephoneServiceAssertion = (credential: VerifiedBillingAppKey, token: string,
  endpoint: string, purpose: 'telephone-routing' | 'telephone-call-proof') =>
  verifyServiceAssertion(credential, token, endpoint, purpose, LookupAssertion);

export const SMS_ADMISSION_PATH = '/apps/v1/nessie/phone-profile/sms-admission';
const SmsAssertion = LookupAssertion.omit({ call_id: true, purpose: true }).extend({
  purpose: z.literal('telephone-sms-routing'), account_sid: z.string().regex(/^AC[a-fA-F0-9]{32}$/),
  message_sid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
}).strict();
export const verifyTelephoneSmsAssertion = (credential: VerifiedBillingAppKey, token: string) =>
  verifyServiceAssertion(credential, token, SMS_ADMISSION_PATH, 'telephone-sms-routing', SmsAssertion);

export function telephoneRoutingBinding(scope: { organisation_id: string; team_id: string; owner_subject?: string }, number: string) {
  return telephoneDigest(JSON.stringify([scope.organisation_id, scope.team_id, number,
    ...(scope.owner_subject === undefined ? [] : [scope.owner_subject])]));
}

/** Attests membership of an already-known routing owner, without returning their profile or authority. */
export async function telephoneOwnerActive(tx: PrismaClient,
  scope: { organisation_id: string; team_id: string; owner_subject?: string }): Promise<boolean> {
  if (scope.owner_subject === undefined) return true;
  return Boolean(await tx.user.findFirst({ where: { id: scope.owner_subject, lifecycleStatus: 'ACTIVE',
    orgMembers: { some: { orgId: scope.organisation_id, status: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' } } },
    teamMembers: { some: { teamId: scope.team_id, status: 'ACTIVE',
      team: { orgId: scope.organisation_id, lifecycleStatus: 'ACTIVE' } } } }, select: { id: true } }));
}
