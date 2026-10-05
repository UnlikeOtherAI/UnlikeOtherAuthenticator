import { createHash } from 'node:crypto';
import { BillingAppKeyPurpose, MembershipStatus, Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertAuthenticationEpoch } from './authentication-epoch.service.js';
import { verifyBillingAppKey } from './billing-app-key.service.js';
import { verifyLedgerRuntimeKey } from './billing-ledger-runtime-key.service.js';
import { resolveConfidentialDelegationForSource } from './confidential-delegation.service.js';
import { verifyChainedSubjectAccessToken } from './confidential-chained-token-exchange.service.js';
import { getActiveClientOrgContext } from './org-context.service.js';
import { signConfidentialAccessToken, type ConfidentialActorChain } from './oauth/access-token.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';

const RECIPIENT_ORIGIN = 'https://api.deepwater.live';
const RECIPIENT_PRODUCT = 'deepwater';
const LEDGER_AUDIENCE = 'https://ledger.unlikeotherai.com';
const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_SECONDS = 120;
const SECRET = /^uoa_job_[A-Za-z0-9_-]{43}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const WATER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export type JobComputePurpose = 'research_compute' | 'scope_turn_compute';
export type JobComputeIdentity = {
  originInvocationId: string;
  ledgerJobId: string;
  waterJobId: string;
  scopeTurnId: string | null;
  purpose: JobComputePurpose;
};

export type IssueJobComputeRenewalInput = JobComputeIdentity & {
  issueKey: string;
  secret: string;
};

const JobClaim = z.object({
  grant_id: z.string().min(1),
  origin_invocation_id: z.string().min(1),
  ledger_job_id: z.string().min(1),
  water_job_id: z.string().uuid(),
  scope_turn_id: z.string().nullable(),
  purpose: z.enum(['research_compute', 'scope_turn_compute']),
  origin_product: z.string().min(1),
  origin_source_domain: z.string().min(1),
}).strict();

export type JobComputeDispatchIdentity = JobComputeIdentity & { grantId: string };

type Grant = NonNullable<Awaited<ReturnType<PrismaClient['billingJobComputeRenewal']['findUnique']>>>;

function deny(code = 'JOB_COMPUTE_RENEWAL_DENIED'): never {
  throw new AppError('FORBIDDEN', 403, code);
}

function validIdentity(input: JobComputeIdentity): void {
  if (!ID.test(input.originInvocationId) || !ID.test(input.ledgerJobId)
    || !WATER_UUID.test(input.waterJobId)
    || (input.purpose === 'scope_turn_compute') !== (input.scopeTurnId !== null)
    || (input.scopeTurnId !== null && !ID.test(input.scopeTurnId))) {
    throw new AppError('BAD_REQUEST', 400, 'JOB_COMPUTE_IDENTITY_INVALID');
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function immutableKey(input: JobComputeIdentity): string {
  return hash(JSON.stringify([
    input.originInvocationId, input.ledgerJobId, input.waterJobId,
    input.scopeTurnId, input.purpose,
  ]));
}

function identityMatches(row: Grant, input: JobComputeIdentity): boolean {
  return row.originInvocationId === input.originInvocationId
    && row.ledgerJobId === input.ledgerJobId
    && row.waterJobId === input.waterJobId
    && row.scopeTurnId === input.scopeTurnId
    && row.purpose === input.purpose;
}

function originalIdentityDomain(sourceDomain: string, actor: ConfidentialActorChain | undefined): string {
  let domain = sourceDomain;
  for (let current = actor; current; current = current.act) domain = current.sub;
  return domain;
}

async function assertCurrentGrantAuthority(
  tx: Prisma.TransactionClient,
  row: Pick<Grant, 'subjectId' | 'tokenVersion' | 'identityDomain' | 'orgId' | 'teamId'
    | 'originProduct' | 'originSourceDomain' | 'ledgerAudience' | 'originRuntimeKeyId'>,
) {
  await lockProductTeamPolicyShared(tx);
  const activeOriginKey = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM billing_ledger_runtime_keys
    WHERE id = ${row.originRuntimeKeyId} AND revoked_at IS NULL FOR SHARE`);
  if (activeOriginKey.length !== 1) deny();
  await resolveConfidentialDelegationForSource({ sourceDomain: row.originSourceDomain,
    product: row.originProduct, resource: row.ledgerAudience, scope: 'ai.invoke' },
  { prisma: tx as unknown as PrismaClient });
  await resolveConfidentialDelegationForSource({ sourceDomain: new URL(RECIPIENT_ORIGIN).hostname,
    product: RECIPIENT_PRODUCT, resource: row.ledgerAudience, scope: 'ai.invoke' },
  { prisma: tx as unknown as PrismaClient });
  await lockAndAssertAuthenticationEpoch({ userId: row.subjectId,
    domain: row.identityDomain, credentialEpoch: row.tokenVersion }, { prisma: tx });
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${row.orgId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${row.teamId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM org_members
    WHERE org_id = ${row.orgId} AND user_id = ${row.subjectId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM team_members
    WHERE team_id = ${row.teamId} AND user_id = ${row.subjectId} FOR SHARE`);
  const [user, role, orgMember, team, currentKey] = await Promise.all([
    tx.user.findUnique({ where: { id: row.subjectId }, select: { email: true, lifecycleStatus: true } }),
    tx.domainRole.findUnique({ where: { domain_userId: { domain: row.identityDomain,
      userId: row.subjectId } }, select: { role: true } }),
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId: row.orgId,
      userId: row.subjectId } }, select: { status: true } }),
    tx.team.findFirst({ where: { id: row.teamId, orgId: row.orgId,
      lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' },
      members: { some: { userId: row.subjectId, status: MembershipStatus.ACTIVE } } },
    select: { id: true } }),
    tx.billingLedgerRuntimeKey.findUnique({ where: { id: row.originRuntimeKeyId },
      select: { revokedAt: true, ledgerAudience: true, sourceDomain: true,
        service: { select: { identifier: true, active: true } } } }),
  ]);
  if (!user || user.lifecycleStatus !== 'ACTIVE' || !user.email || !role
    || orgMember?.status !== MembershipStatus.ACTIVE || !team
    || !currentKey || currentKey.revokedAt || !currentKey.service.active
    || currentKey.service.identifier !== row.originProduct
    || currentKey.sourceDomain !== row.originSourceDomain
    || currentKey.ledgerAudience !== row.ledgerAudience) deny();
  const org = await getActiveClientOrgContext({ userId: row.subjectId,
    domain: row.identityDomain, orgId: row.orgId, groupsEnabled: false },
  { crossProductPrisma: tx as unknown as PrismaClient,
    policyPrisma: tx as unknown as PrismaClient, prisma: tx as unknown as PrismaClient });
  if (!org || !org.teams.includes(row.teamId) || !org.team_roles[row.teamId]) deny();
  return { email: user.email, org: {
    ...org, teams: [row.teamId], team_roles: { [row.teamId]: org.team_roles[row.teamId] },
  } };
}

async function assertRecipientAvailable(tx: Prisma.TransactionClient): Promise<void> {
  const current = await tx.billingAppKey.findFirst({
    where: { purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      actorIssuer: RECIPIENT_ORIGIN,
      service: { identifier: RECIPIENT_PRODUCT, active: true } },
    select: { id: true },
  });
  if (!current) deny('JOB_COMPUTE_RECIPIENT_UNAVAILABLE');
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM billing_app_keys
    WHERE id = ${current.id} AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) FOR SHARE`);
  if (locked.length !== 1) deny('JOB_COMPUTE_RECIPIENT_UNAVAILABLE');
}

async function issueTransaction<T>(db: PrismaClient,
  action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.$transaction(action,
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const candidate = error as { code?: string; meta?: { code?: string } };
      if (!['P2002', 'P2034'].includes(candidate.code ?? '')
        && !(candidate.code === 'P2010' && candidate.meta?.code === '40001')) throw error;
      if (attempt === 4) {
        throw new AppError('INTERNAL', 503, 'JOB_COMPUTE_ISSUE_RETRY_EXHAUSTED');
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw new AppError('INTERNAL', 503, 'JOB_COMPUTE_ISSUE_RETRY_EXHAUSTED');
}

export async function issueJobComputeRenewal(
  params: { runtimeSecret: string; delegation: string; input: IssueJobComputeRenewalInput },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  const input = params.input;
  validIdentity(input);
  if (!HEX.test(input.issueKey) || !SECRET.test(input.secret)) {
    throw new AppError('BAD_REQUEST', 400, 'JOB_COMPUTE_ISSUE_INVALID');
  }
  const db = deps.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma: db });
  const original = await verifyChainedSubjectAccessToken({ subjectToken: params.delegation,
    callerAudience: key.ledgerAudience, issuer: getPublicBaseUrl() });
  if (!Number.isSafeInteger(original.tv) || key.ledgerAudience !== LEDGER_AUDIENCE
    || original.product !== key.service.identifier
    || original.source_domain !== key.sourceDomain
    || original.scope !== 'ai.invoke') deny('JOB_COMPUTE_ORIGIN_MISMATCH');
  const now = deps.now ?? new Date();
  const identityKey = immutableKey(input);
  const secretDigest = hash(input.secret);
  const identityDomain = originalIdentityDomain(original.source_domain, original.act);
  const row = await issueTransaction(db, async (tx) => {
    const frozen = { subjectId: original.sub, tokenVersion: original.tv,
      originTokenJti: original.jti,
      identityDomain, orgId: original.active.orgId, teamId: original.active.teamId,
      originProduct: original.product, originSourceDomain: original.source_domain,
      ledgerAudience: key.ledgerAudience, originRuntimeKeyId: key.id };
    await assertCurrentGrantAuthority(tx, frozen);
    await assertRecipientAvailable(tx);
    const existing = await tx.billingJobComputeRenewal.findFirst({
      where: { OR: [{ issueKey: input.issueKey }, { identityKey }] },
    });
    if (existing) {
      if (existing.issueKey !== input.issueKey || existing.identityKey !== identityKey
        || existing.secretDigest !== secretDigest || !identityMatches(existing, input)
        || Object.entries(frozen).some(([field, value]) =>
          existing[field as keyof typeof frozen] !== value)) {
        throw new AppError('BAD_REQUEST', 409, 'JOB_COMPUTE_ISSUE_CONFLICT');
      }
      if (existing.revokedAt || existing.expiresAt <= now) deny();
      return existing;
    }
    return tx.billingJobComputeRenewal.create({ data: {
      ...frozen, issueKey: input.issueKey, identityKey, secretDigest,
      originInvocationId: input.originInvocationId,
      ledgerJobId: input.ledgerJobId, waterJobId: input.waterJobId,
      scopeTurnId: input.scopeTurnId, purpose: input.purpose,
      recipientOrigin: RECIPIENT_ORIGIN, recipientProduct: RECIPIENT_PRODUCT,
      originalActorChain: original.act as Prisma.InputJsonValue | undefined,
      createdAt: now, expiresAt: new Date(now.getTime() + GRANT_TTL_MS),
    } });
  });
  return { grant_id: row.id, expires_at: row.expiresAt.toISOString(),
    purpose: row.purpose, ledger_job_id: row.ledgerJobId,
    water_job_id: row.waterJobId, scope_turn_id: row.scopeTurnId };
}

/** Recover an already committed issue after Ledger lost the HTTP acknowledgement.
 * This endpoint can never create or extend a grant, and needs no stale human JWT.
 */
export async function recoverJobComputeRenewal(
  params: { runtimeSecret: string; input: IssueJobComputeRenewalInput },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  const input = params.input;
  validIdentity(input);
  if (!HEX.test(input.issueKey) || !SECRET.test(input.secret)) deny();
  const db = deps.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma: db });
  const now = deps.now ?? new Date();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_job_compute_renewals
      WHERE issue_key = ${input.issueKey} FOR SHARE`);
    const row = await tx.billingJobComputeRenewal.findUnique({
      where: { issueKey: input.issueKey },
    });
    if (!row || row.originRuntimeKeyId !== key.id
      || row.originProduct !== key.service.identifier
      || row.originSourceDomain !== key.sourceDomain
      || row.ledgerAudience !== key.ledgerAudience
      || row.identityKey !== immutableKey(input)
      || row.secretDigest !== hash(input.secret)
      || !identityMatches(row, input)
      || row.revokedAt || row.expiresAt <= now) deny();
    await assertCurrentGrantAuthority(tx, row);
    return { grant_id: row.id, expires_at: row.expiresAt.toISOString(),
      purpose: row.purpose, ledger_job_id: row.ledgerJobId,
      water_job_id: row.waterJobId, scope_turn_id: row.scopeTurnId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function recipientGrant(
  params: { appKey: string; secret: string; grantId: string; identity: JobComputeIdentity },
  tx: Prisma.TransactionClient,
  now: Date,
) {
  validIdentity(params.identity);
  if (!SECRET.test(params.secret)) deny();
  await lockProductTeamPolicyShared(tx);
  const recipient = await verifyBillingAppKey(params.appKey,
    { prisma: tx as unknown as PrismaClient, now: () => now });
  if (recipient.purpose !== BillingAppKeyPurpose.CUSTOMER_LIFECYCLE
    || recipient.service.identifier !== RECIPIENT_PRODUCT
    || recipient.actorIssuer !== RECIPIENT_ORIGIN) deny('JOB_COMPUTE_RECIPIENT_MISMATCH');
  const activeRecipient = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM billing_app_keys
    WHERE id = ${recipient.id} AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${now}) FOR SHARE`);
  if (activeRecipient.length !== 1) deny('JOB_COMPUTE_RECIPIENT_MISMATCH');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_job_compute_renewals
    WHERE id = ${params.grantId} FOR UPDATE`);
  const row = await tx.billingJobComputeRenewal.findUnique({ where: { id: params.grantId } });
  if (!row || row.secretDigest !== hash(params.secret)
    || row.recipientOrigin !== RECIPIENT_ORIGIN
    || row.recipientProduct !== RECIPIENT_PRODUCT
    || !identityMatches(row, params.identity)) deny();
  return row;
}

export async function assertLiveJobComputeDispatch(
  tx: Prisma.TransactionClient,
  params: {
    claim: unknown;
    identity: JobComputeDispatchIdentity | null;
    runtimeKeyId: string;
    subjectId: string;
    orgId: string;
    teamId: string;
    tokenVersion: number;
    now: Date;
  },
): Promise<void> {
  if (params.claim === undefined && params.identity === null) return;
  const claim = JobClaim.safeParse(params.claim);
  if (!claim.success || !params.identity) deny('JOB_COMPUTE_DISPATCH_MISMATCH');
  validIdentity(params.identity);
  const c = claim.data;
  if (c.grant_id !== params.identity.grantId
    || c.origin_invocation_id !== params.identity.originInvocationId
    || c.ledger_job_id !== params.identity.ledgerJobId
    || c.water_job_id !== params.identity.waterJobId
    || c.scope_turn_id !== params.identity.scopeTurnId
    || c.purpose !== params.identity.purpose) deny('JOB_COMPUTE_DISPATCH_MISMATCH');
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_job_compute_renewals
    WHERE id = ${c.grant_id} FOR SHARE`);
  const row = await tx.billingJobComputeRenewal.findUnique({ where: { id: c.grant_id } });
  if (!row || row.revokedAt || row.expiresAt <= params.now
    || !identityMatches(row, params.identity)
    || row.subjectId !== params.subjectId || row.orgId !== params.orgId
    || row.teamId !== params.teamId || row.tokenVersion !== params.tokenVersion
    || row.originProduct !== c.origin_product
    || row.originSourceDomain !== c.origin_source_domain
    || row.recipientProduct !== RECIPIENT_PRODUCT
    || row.recipientOrigin !== RECIPIENT_ORIGIN) deny('JOB_COMPUTE_DISPATCH_MISMATCH');
  const runtimeKey = await tx.billingLedgerRuntimeKey.findUnique({
    where: { id: params.runtimeKeyId }, select: { service: { select: { identifier: true } },
      sourceDomain: true, ledgerAudience: true },
  });
  if (!runtimeKey || runtimeKey.service.identifier !== RECIPIENT_PRODUCT
    || runtimeKey.sourceDomain !== new URL(RECIPIENT_ORIGIN).hostname
    || runtimeKey.ledgerAudience !== row.ledgerAudience) deny('JOB_COMPUTE_DISPATCH_MISMATCH');
  await assertCurrentGrantAuthority(tx, row);
}

export async function renewJobComputeAuthority(
  params: { appKey: string; secret: string; grantId: string; identity: JobComputeIdentity },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  const db = deps.prisma ?? getAdminPrisma();
  const now = deps.now ?? new Date();
  return db.$transaction(async (tx) => {
    const row = await recipientGrant(params, tx, now);
    if (row.revokedAt || row.expiresAt <= now) deny();
    const current = await assertCurrentGrantAuthority(tx, row);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const exp = Math.min(Math.floor(row.expiresAt.getTime() / 1000),
      nowSeconds + TOKEN_TTL_SECONDS);
    if (exp <= nowSeconds) deny();
    const actor = row.originalActorChain as ConfidentialActorChain | null;
    const jwt = await signConfidentialAccessToken({
      subject: row.subjectId, credentialEpoch: row.tokenVersion, email: current.email,
      sourceDomain: new URL(RECIPIENT_ORIGIN).hostname,
      product: RECIPIENT_PRODUCT, resource: row.ledgerAudience,
      issuer: getPublicBaseUrl(), ttlSeconds: TOKEN_TTL_SECONDS,
      expiresAtEpochSeconds: exp,
      scope: 'ai.invoke', org: current.org,
      active: { orgId: row.orgId, teamId: row.teamId },
      actor: { sub: row.originSourceDomain, product: row.originProduct,
        ...(actor ? { act: actor } : {}) },
      jobCompute: { grant_id: row.id, origin_invocation_id: row.originInvocationId,
        ledger_job_id: row.ledgerJobId, water_job_id: row.waterJobId,
        scope_turn_id: row.scopeTurnId, purpose: row.purpose as JobComputePurpose,
        origin_product: row.originProduct, origin_source_domain: row.originSourceDomain },
    });
    return { access_token: jwt, token_type: 'Bearer' as const,
      expires_in: exp - nowSeconds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokeJobComputeRenewal(
  params: { appKey: string; secret: string; grantId: string; identity: JobComputeIdentity },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  const db = deps.prisma ?? getAdminPrisma();
  const now = deps.now ?? new Date();
  await db.$transaction(async (tx) => {
    const row = await recipientGrant(params, tx, now);
    if (!row.revokedAt) await tx.billingJobComputeRenewal.update({
      where: { id: row.id }, data: { revokedAt: now },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { revoked: true as const };
}

export async function revokeJobComputeRenewalFromOrigin(
  params: { runtimeSecret: string; grantId: string;
    issueKey: string; identity: JobComputeIdentity },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  validIdentity(params.identity);
  if (!HEX.test(params.issueKey)) deny();
  const db = deps.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma: db });
  const now = deps.now ?? new Date();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_job_compute_renewals
      WHERE id = ${params.grantId} FOR UPDATE`);
    const row = await tx.billingJobComputeRenewal.findUnique({
      where: { id: params.grantId },
    });
    if (!row || row.originRuntimeKeyId !== key.id || row.issueKey !== params.issueKey
      || row.identityKey !== immutableKey(params.identity)
      || !identityMatches(row, params.identity)) deny();
    if (!row.revokedAt) await tx.billingJobComputeRenewal.update({
      where: { id: row.id }, data: { revokedAt: now },
    });
  });
  return { revoked: true as const };
}
