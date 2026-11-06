import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockAndAssertAuthenticationEpochShared } from './authentication-epoch.service.js';
import { verifyLedgerRuntimeKey } from './billing-ledger-runtime-key.service.js';
import { verifyChainedSubjectAccessToken } from './confidential-chained-token-exchange.service.js';
import { assertCurrentGrantAuthority, assertRecipientAvailable, LEDGER_AUDIENCE,
  RECIPIENT_ORIGIN, RECIPIENT_PRODUCT } from './billing-job-compute-authority.service.js';
import { deny, hash, HEX, identityMatches, immutableKey, originalIdentityDomain, SECRET, validIdentity,
  type IssueJobComputeRenewalInput } from './billing-job-compute-identity.js';
import { lockLiveJobComputeLineage } from './billing-job-compute-lineage.service.js';
import { issueTransaction } from './billing-job-compute-renewal.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';

const Claim = z.object({
  grant_id: z.string().uuid(), origin_invocation_id: z.string().min(1),
  ledger_job_id: z.string().min(1), water_job_id: z.string().uuid(),
  scope_turn_id: z.null(), purpose: z.literal('research_compute'),
  origin_product: z.literal('deepwater'), origin_source_domain: z.literal('api.deepwater.live'),
}).strict();

/** Ledger may derive one separately metered attempt for an existing logical
 * DeepWater run. The recipient's job token is never accepted as a fresh human
 * launch. Ledger must separately prove infrastructure failure/no dispatch.
 */
export async function continueJobComputeRenewal(
  params: { runtimeSecret: string; delegation: string; grantId: string;
    input: IssueJobComputeRenewalInput },
  deps: { prisma?: PrismaClient; now?: Date } = {},
) {
  const input = params.input;
  validIdentity(input);
  if (!HEX.test(input.issueKey) || !SECRET.test(input.secret)
    || input.purpose !== 'research_compute' || input.scopeTurnId !== null) deny();
  const db = deps.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma: db });
  const token = await verifyChainedSubjectAccessToken({ subjectToken: params.delegation,
    callerAudience: LEDGER_AUDIENCE, issuer: getPublicBaseUrl() }, { prisma: db });
  const claim = Claim.safeParse(token.job_compute);
  if (!claim.success || claim.data.grant_id !== params.grantId
    || token.product !== RECIPIENT_PRODUCT
    || token.source_domain !== new URL(RECIPIENT_ORIGIN).hostname
    || token.scope !== 'ai.invoke' || key.ledgerAudience !== LEDGER_AUDIENCE) deny();
  const now = deps.now ?? new Date();
  const row = await issueTransaction(db, async function continueExistingGrant(tx) {
    // The signed epoch supplies the first lock; authority is checked again
    // from the persisted parent before any child is written.
    await lockAndAssertAuthenticationEpochShared({ userId: token.sub,
      domain: originalIdentityDomain(token.source_domain, token.act), credentialEpoch: token.tv }, { prisma: tx });
    await lockProductTeamPolicyShared(tx);
    // Read Committed observes authority committed while either shared lock
    // waited. Serialize this parent's continuation before discovering a child;
    // the unique constraint remains the cross-process one-child invariant.
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${`uoa:job-compute-continuation:v1:${params.grantId}`}, 0))::text`);
    const childHint = await tx.billingJobComputeRenewal.findUnique({
      where: { continuationOfId: params.grantId }, select: { id: true },
    });
    await lockLiveJobComputeLineage(tx, childHint?.id ?? params.grantId, now);
    const parent = await tx.billingJobComputeRenewal.findUniqueOrThrow({ where: { id: params.grantId } });
    const c = claim.data;
    if (parent.originRuntimeKeyId !== key.id || parent.originProduct !== key.service.identifier
      || parent.originSourceDomain !== key.sourceDomain || parent.ledgerAudience !== key.ledgerAudience
      || parent.subjectId !== token.sub || parent.tokenVersion !== token.tv
      || parent.identityDomain !== originalIdentityDomain(token.source_domain, token.act)
      || parent.orgId !== token.active.orgId || parent.teamId !== token.active.teamId
      || parent.originInvocationId !== c.origin_invocation_id || parent.ledgerJobId !== c.ledger_job_id
      || parent.waterJobId !== c.water_job_id || parent.purpose !== c.purpose
      || parent.scopeTurnId !== null || parent.parentSalesJobGrantId !== null
      || input.originInvocationId !== parent.originInvocationId || input.waterJobId !== parent.waterJobId
      || input.ledgerJobId === parent.ledgerJobId) deny();
    await assertCurrentGrantAuthority(tx, parent);
    await assertRecipientAvailable(tx);
    if (token.exp <= Math.floor(Date.now() / 1000)) deny();
    const existing = await tx.billingJobComputeRenewal.findFirst({
      where: { OR: [{ continuationOfId: parent.id }, { issueKey: input.issueKey },
        { identityKey: immutableKey(input) }] },
    });
    if (existing) {
      if (existing.continuationOfId !== parent.id || existing.issueKey !== input.issueKey
        || existing.identityKey !== immutableKey(input) || existing.secretDigest !== hash(input.secret)
        || !identityMatches(existing, input)) {
        throw new AppError('BAD_REQUEST', 409, 'JOB_COMPUTE_CONTINUATION_CONFLICT');
      }
      if (existing.id !== childHint?.id) {
        throw new AppError('BAD_REQUEST', 409, 'JOB_COMPUTE_CONTINUATION_CONFLICT');
      }
      return existing;
    }
    const { id: _id, issueKey: _issueKey, identityKey: _identityKey, secretDigest: _secretDigest,
      ledgerJobId: _ledgerJobId, createdAt: _createdAt, revokedAt: _revokedAt,
      continuationOfId: _parentId, ...authority } = parent;
    return tx.billingJobComputeRenewal.create({ data: {
      ...authority, originalActorChain: parent.originalActorChain ?? Prisma.JsonNull,
      continuationOfId: parent.id, issueKey: input.issueKey, identityKey: immutableKey(input),
      secretDigest: hash(input.secret), ledgerJobId: input.ledgerJobId, createdAt: now,
      // expiresAt and every origin/identity field are copied from the parent.
    } });
  }, Prisma.TransactionIsolationLevel.ReadCommitted);
  return { grant_id: row.id, expires_at: row.expiresAt.toISOString(), purpose: row.purpose,
    ledger_job_id: row.ledgerJobId, water_job_id: row.waterJobId, scope_turn_id: row.scopeTurnId };
}
