import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { getEnv } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockBillingAdminEffectAuthority, type BillingAdminEffectActor } from './billing-admin-effect-authority.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { getAdminAuthDomain } from '../config/env.js';
import {
  parseSmsFxEvidence, readSmsFxEvidence, smsFxWithinBand, SMS_FX_POLICY, SMS_FX_SOURCE, type SmsFxEvidence,
} from './billing-sms-fx-evidence.service.js';

// Canonical decimal syntax fits Decimal(38,18) without rounding or JS float conversion.
const Bound = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/);
export const SmsRoutePolicyImportSchema = z.object({
  account_sid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  country: z.string().regex(/^[A-Z]{2}$/),
  direction: z.enum(['inbound', 'outbound']),
  currency: z.enum(['USD', 'EUR']),
  additional_per_segment: Bound,
  additional_per_message: Bound,
  source: z.string().trim().min(8).max(500),
  evidence: z.string().trim().min(20).max(32_000),
  expires_at: z.string().datetime({ offset: true }),
}).strict();
const FxSchema = z.object({
  policy: z.literal(SMS_FX_POLICY), source: z.literal(SMS_FX_SOURCE),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/), rate_date: z.string().date(),
  observed_at: z.string().datetime(), expires_at: z.string().datetime(), usd_per_eur: Bound,
}).strict();
const RouteSchema = SmsRoutePolicyImportSchema.omit({ evidence: true }).extend({
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  observed_at: z.string().datetime(),
}).strict();
const PreviewAudience = 'uoa:sms-operator-policy-preview:v1';
const Reason = z.string().trim().min(8).max(500);
export type SmsPolicyActor = BillingAdminEffectActor & { userId: string; tokenVersion: number };
export type SmsRoutePolicyImport = z.infer<typeof SmsRoutePolicyImportSchema>;
export type SmsRoutePolicyEvidence = z.infer<typeof RouteSchema>;
/** An operator acceptance names the exact subject; the renewal job never claims one. */
export type SmsPolicyAcceptor = { kind: 'operator'; actor: SmsPolicyActor } | { kind: 'renewal_job' };
type FxPolicyValue = z.infer<typeof FxSchema>;

function invalid(code = 'BILLING_SMS_POLICY_PREVIEW_INVALID') {
  return new AppError('BAD_REQUEST', 409, code);
}
function key() {
  const secret = getEnv().ADMIN_ACCESS_TOKEN_SECRET;
  if (!secret) throw new AppError('INTERNAL', 500, 'ADMIN_ACCESS_TOKEN_SECRET_REQUIRED');
  return new TextEncoder().encode(secret);
}
function fresh(expiresAt: string, now: Date) {
  if (Date.parse(expiresAt) <= now.getTime()) throw invalid('BILLING_SMS_POLICY_EXPIRED');
}
export async function lockSmsPolicyAcceptance(tx: Prisma.TransactionClient, acceptor: SmsPolicyAcceptor, digest: string) {
  if (acceptor.kind === 'operator') {
    await lockRefreshSessionUserDomain({ userId: acceptor.actor.userId, domain: getAdminAuthDomain() }, { prisma: tx });
    await lockBillingAdminEffectAuthority(tx, acceptor.actor);
  }
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`uoa:sms-policy:${digest}`}, 0))::text`);
}
function acceptedBy(acceptor: SmsPolicyAcceptor) {
  return acceptor.kind === 'operator'
    ? { acceptedBy: 'operator', acceptedByUserId: acceptor.actor.userId }
    : { acceptedBy: 'renewal_job', acceptedByUserId: null };
}
function fxDto(evidence: SmsFxEvidence) {
  return FxSchema.parse({ policy: evidence.policy, source: evidence.source,
    source_digest: evidence.sourceDigest, rate_date: evidence.rateDate.toISOString().slice(0, 10),
    observed_at: evidence.observedAt.toISOString(), expires_at: evidence.expiresAt.toISOString(),
    usd_per_eur: evidence.usdPerEur });
}
/** The complete-import digest every route acceptance binds, whoever assembled the import. */
export function smsRouteImportDigest(value: SmsRoutePolicyImport): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function preview<T extends object>(kind: 'fx' | 'route' | 'country', evidence: T,
  actor: SmsPolicyActor, now: Date) {
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const previewToken = await new SignJWT({ kind, evidence, tv: actor.tokenVersion })
    .setProtectedHeader({ alg: 'HS256', typ: 'sms-policy-preview+jwt' })
    .setIssuer(PreviewAudience).setAudience(PreviewAudience).setSubject(actor.userId)
    .setIssuedAt(Math.floor(now.getTime() / 1000)).setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return { evidence, preview_token: previewToken, preview_expires_at: expiresAt.toISOString() };
}
async function reviewed(kind: 'fx' | 'route' | 'country', token: string,
  actor: SmsPolicyActor, now: Date) {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(), { algorithms: ['HS256'],
      issuer: PreviewAudience, audience: PreviewAudience, subject: actor.userId, currentDate: now });
    if (protectedHeader.typ !== 'sms-policy-preview+jwt' || payload.kind !== kind ||
        payload.tv !== actor.tokenVersion) throw invalid();
    return payload.evidence;
  } catch { throw invalid(); }
}
// Shared with the one-button Add country review, which assembles its own evidence.
export { Bound as SmsPolicyBound, RouteSchema as SmsRoutePolicyEvidenceSchema, fresh as assertSmsPolicyFresh, preview as signSmsPolicyPreview, reviewed as readSmsPolicyPreview,
  fxDto as smsFxPolicyValue };

/** Append one FX acceptance; an exact retry returns the original without extending freshness. */
export async function insertSmsFxPolicy(tx: Prisma.TransactionClient, value: FxPolicyValue,
  acceptor: SmsPolicyAcceptor, now: Date, acceptanceReason: string) {
  const existing = await tx.billingSmsFxSnapshot.findUnique({
    where: { policy_sourceDigest: { policy: value.policy, sourceDigest: value.source_digest } },
  });
  if (existing) return existing;
  return tx.billingSmsFxSnapshot.create({ data: {
    policy: value.policy, source: value.source, sourceDigest: value.source_digest,
    rateDate: new Date(`${value.rate_date}T00:00:00.000Z`), observedAt: new Date(value.observed_at),
    expiresAt: new Date(value.expires_at), usdPerEur: value.usd_per_eur,
    ...acceptedBy(acceptor), acceptedAt: now, acceptanceReason,
  } });
}

/** Append one route acceptance; nothing ever updates or removes an accepted record. */
export async function insertSmsRoutePolicy(tx: Prisma.TransactionClient, value: SmsRoutePolicyEvidence,
  acceptor: SmsPolicyAcceptor, now: Date, acceptanceReason: string,
  baseline: { providerPrice?: string | null; renewalOfId?: string | null } = {}) {
  const existing = await tx.billingSmsRoutePolicy.findFirst({ where: {
    evidenceDigest: value.evidence_digest, accountSid: value.account_sid, country: value.country,
    direction: value.direction, currency: value.currency,
  } });
  if (existing) return existing;
  return tx.billingSmsRoutePolicy.create({ data: {
    accountSid: value.account_sid, country: value.country, direction: value.direction,
    currency: value.currency, additionalPerSegment: value.additional_per_segment,
    additionalPerMessage: value.additional_per_message, source: value.source,
    evidenceDigest: value.evidence_digest, expiresAt: new Date(value.expires_at),
    ...acceptedBy(acceptor), acceptedAt: now, acceptanceReason,
    providerPrice: baseline.providerPrice ?? null, renewalOfId: baseline.renewalOfId ?? null,
  } });
}

export async function previewSmsFxPolicy(actor: SmsPolicyActor, xml?: string) {
  const now = new Date();
  const evidence = xml === undefined ? await readSmsFxEvidence() : parseSmsFxEvidence(xml, now);
  fresh(evidence.expiresAt.toISOString(), now);
  return preview('fx', fxDto(evidence), actor, now);
}

export async function previewSmsRoutePolicy(actor: SmsPolicyActor, input: SmsRoutePolicyImport) {
  const value = SmsRoutePolicyImportSchema.parse(input); const now = new Date();
  fresh(value.expires_at, now);
  // Bind the entire reviewed document to its dimensional policy, not only a pasted digest.
  const evidenceDigest = smsRouteImportDigest(value);
  const { evidence: document, ...dimensions } = value;
  return { ...await preview('route', { ...dimensions, evidence_digest: evidenceDigest,
    observed_at: now.toISOString() }, actor, now), evidence_document: document };
}

export async function acceptSmsFxPolicy(actor: SmsPolicyActor, token: string, reason: string) {
  const acceptanceReason = Reason.parse(reason);
  const value = FxSchema.parse(await reviewed('fx', token, actor, new Date()));
  const acceptor = { kind: 'operator', actor } as const;
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, acceptor, value.source_digest);
    const now = new Date();
    // A preview that expires while waiting for authority locks cannot commit.
    await reviewed('fx', token, actor, now); fresh(value.expires_at, now);
    return insertSmsFxPolicy(tx, value, acceptor, now, acceptanceReason);
  });
}

/** Refresh and accept: the renewal job's band check, accepted under the operator's own subject. */
export async function acceptSmsFxRefresh(actor: SmsPolicyActor, read: () => Promise<SmsFxEvidence> = readSmsFxEvidence) {
  const value = fxDto(await read());
  const bandBps = getEnv().BILLING_SMS_POLICY_AUTORENEW_FX_BAND_BPS;
  const acceptor = { kind: 'operator', actor } as const;
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, acceptor, value.source_digest);
    const now = new Date(); fresh(value.expires_at, now);
    const last = await tx.billingSmsFxSnapshot.findFirst({ where: { policy: SMS_FX_POLICY },
      orderBy: [{ rateDate: 'desc' }, { acceptedAt: 'desc' }] });
    if (!last) throw invalid('BILLING_SMS_FX_BASELINE_REQUIRED');
    const lastRate = last.usdPerEur.toFixed();
    if (!smsFxWithinBand(lastRate, value.usd_per_eur, bandBps)) throw invalid('BILLING_SMS_FX_OUTSIDE_BAND');
    return insertSmsFxPolicy(tx, value, acceptor, now, `Refresh and accept: official ECB daily reference ` +
      `${value.rate_date}, USD/EUR ${value.usd_per_eur}, within ±${(bandBps / 100).toFixed(2)}% of the ` +
      `last accepted ${lastRate}; adopted as the commercial USD-per-EUR conversion.`);
  });
}

export async function acceptSmsRoutePolicy(actor: SmsPolicyActor, token: string, reason: string) {
  const acceptanceReason = Reason.parse(reason);
  const value = RouteSchema.parse(await reviewed('route', token, actor, new Date()));
  const acceptor = { kind: 'operator', actor } as const;
  return getAdminPrisma().$transaction(async (tx) => {
    await lockSmsPolicyAcceptance(tx, acceptor, value.evidence_digest); const now = new Date();
    await reviewed('route', token, actor, now); fresh(value.expires_at, now);
    // Manual evidence keeps its operator-chosen expiry, so it records no renewal baseline.
    return insertSmsRoutePolicy(tx, value, acceptor, now, acceptanceReason);
  });
}

export async function listSmsPolicies() {
  const db = getAdminPrisma();
  const [fx, routes] = await Promise.all([
    db.billingSmsFxSnapshot.findMany({ orderBy: { acceptedAt: 'desc' }, take: 50 }),
    db.billingSmsRoutePolicy.findMany({ orderBy: { acceptedAt: 'desc' }, take: 100 }),
  ]);
  return { fx: fx.map(serializeSmsFxPolicy), routes: routes.map(serializeSmsRoutePolicy) };
}
export function serializeSmsFxPolicy(value: Awaited<ReturnType<typeof acceptSmsFxPolicy>>) {
  if (value.policy !== SMS_FX_POLICY || value.source !== SMS_FX_SOURCE) throw invalid('BILLING_SMS_FX_PROVENANCE_INVALID');
  return { ...fxDto({ ...value, policy: SMS_FX_POLICY, source: SMS_FX_SOURCE,
    usdPerEur: value.usdPerEur.toString() }), id: value.id, accepted_by: acceptedByKind(value.acceptedBy),
    accepted_by_user_id: value.acceptedByUserId, accepted_at: value.acceptedAt.toISOString(),
    acceptance_reason: value.acceptanceReason };
}
export function serializeSmsRoutePolicy(value: Awaited<ReturnType<typeof acceptSmsRoutePolicy>>) {
  return { id: value.id, account_sid: value.accountSid, country: value.country,
    direction: value.direction, currency: value.currency,
    additional_per_segment: value.additionalPerSegment.toString(),
    additional_per_message: value.additionalPerMessage.toString(), source: value.source,
    evidence_digest: value.evidenceDigest, expires_at: value.expiresAt.toISOString(),
    accepted_by: acceptedByKind(value.acceptedBy), accepted_by_user_id: value.acceptedByUserId,
    accepted_at: value.acceptedAt.toISOString(), acceptance_reason: value.acceptanceReason,
    provider_price: value.providerPrice?.toString() ?? null, renewal_of_id: value.renewalOfId };
}
function acceptedByKind(value: string): 'operator' | 'renewal_job' {
  if (value !== 'operator' && value !== 'renewal_job') throw invalid('BILLING_SMS_POLICY_PROVENANCE_INVALID');
  return value;
}
