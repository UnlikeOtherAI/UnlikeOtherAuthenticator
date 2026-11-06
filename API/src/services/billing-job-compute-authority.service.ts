import { BillingAppKeyPurpose, MembershipStatus, Prisma, type PrismaClient } from '@prisma/client';
import { lockAndAssertAuthenticationEpochShared } from './authentication-epoch.service.js';
import { resolveConfidentialDelegationForSource } from './confidential-delegation.service.js';
import { getActiveClientOrgContext } from './org-context.service.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { deny, type Grant } from './billing-job-compute-identity.js';

export const RECIPIENT_ORIGIN = 'https://api.deepwater.live';
export const RECIPIENT_PRODUCT = 'deepwater';
export const LEDGER_AUDIENCE = 'https://ledger.unlikeotherai.com';

export async function assertCurrentGrantAuthority(
  tx: Prisma.TransactionClient,
  row: Pick<Grant, 'subjectId' | 'tokenVersion' | 'identityDomain' | 'orgId' | 'teamId'
    | 'originProduct' | 'originSourceDomain' | 'ledgerAudience' | 'originRuntimeKeyId'>,
) {
  // Epoch is the first authority lock. Membership revocation takes epoch before
  // organisation/team rows, so acquiring policy or membership locks first here
  // would invert the order used by callers which also hold a grant row.
  await lockAndAssertAuthenticationEpochShared({ userId: row.subjectId,
    domain: row.identityDomain, credentialEpoch: row.tokenVersion }, { prisma: tx });
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

export async function assertRecipientAvailable(tx: Prisma.TransactionClient): Promise<void> {
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

export async function assertParentSalesJobGrantActive(
  tx: Prisma.TransactionClient,
  row: Grant,
  now: Date,
) {
  if (!row.parentSalesJobGrantId) return null;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM sales_research_job_grants
    WHERE id = ${row.parentSalesJobGrantId}::uuid FOR SHARE`);
  const parent = await tx.salesResearchJobGrant.findUnique({
    where: { id: row.parentSalesJobGrantId },
  });
  if (!parent || parent.revokedAt || parent.authorizedUntil <= now
    || parent.subjectId !== row.subjectId || parent.tokenVersion !== row.tokenVersion
    || parent.sourceDomain !== row.identityDomain || parent.orgId !== row.orgId
    || parent.teamId !== row.teamId || parent.product !== row.originProduct
    || parent.sourceDomain !== row.originSourceDomain
    || parent.resource !== row.ledgerAudience || parent.purpose !== 'research_job') {
    deny('JOB_COMPUTE_PARENT_AUTHORIZATION_INVALID');
  }
  return parent;
}

