import { Prisma } from '@prisma/client';
import { deny, type Grant } from './billing-job-compute-identity.js';

/** Lock the whole authority chain in one stable order, including the leaf.
 * A revocation of any ancestor therefore wins before continuation/dispatch,
 * or waits until that authorized transaction commits.
 */
export async function lockLiveJobComputeLineage(
  tx: Prisma.TransactionClient,
  grantId: string,
  now: Date,
  failureCode?: string,
): Promise<Grant> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE lineage AS (
      SELECT id, continuation_of_id FROM billing_job_compute_renewals WHERE id = ${grantId}
      UNION
      SELECT p.id, p.continuation_of_id FROM billing_job_compute_renewals p
      JOIN lineage c ON p.id = c.continuation_of_id
    )
    SELECT g.id FROM billing_job_compute_renewals g JOIN lineage l ON l.id = g.id
    ORDER BY g.id FOR SHARE OF g`);
  const grants = await tx.billingJobComputeRenewal.findMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  const leaf = grants.find((row) => row.id === grantId);
  if (!leaf || grants.some((row) => row.revokedAt || row.expiresAt <= now)) deny(failureCode);
  const byId = new Map(grants.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (let row: Grant | undefined = leaf; row; row = row.continuationOfId
    ? byId.get(row.continuationOfId) : undefined) {
    if (seen.has(row.id)) deny(failureCode);
    seen.add(row.id);
    if (row.continuationOfId && !byId.has(row.continuationOfId)) deny(failureCode);
    if (row.subjectId !== leaf.subjectId || row.tokenVersion !== leaf.tokenVersion
      || row.identityDomain !== leaf.identityDomain || row.orgId !== leaf.orgId
      || row.teamId !== leaf.teamId || row.waterJobId !== leaf.waterJobId
      || row.originInvocationId !== leaf.originInvocationId
      || row.originRuntimeKeyId !== leaf.originRuntimeKeyId
      || row.originTokenJti !== leaf.originTokenJti
      || row.originProduct !== leaf.originProduct || row.originSourceDomain !== leaf.originSourceDomain
      || row.recipientOrigin !== leaf.recipientOrigin || row.recipientProduct !== leaf.recipientProduct
      || row.parentSalesJobGrantId !== leaf.parentSalesJobGrantId
      || row.ledgerAudience !== leaf.ledgerAudience || row.purpose !== leaf.purpose
      || row.scopeTurnId !== leaf.scopeTurnId || row.expiresAt < leaf.expiresAt) deny(failureCode);
  }
  if (seen.size !== grants.length) deny(failureCode);
  return leaf;
}
