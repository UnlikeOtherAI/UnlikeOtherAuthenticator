import { createHash } from 'node:crypto';
import { Prisma, type ProductErasurePolicy } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { isActiveUser } from './entity-lifecycle.service.js';

// Website and public OAuth access tokens have a maximum lifetime of 60 minutes.
// Allow the verifier's clock tolerance before admitting a new participation.
const oldCredentialWindow = 61 * 60_000;
export async function rejoinPreview(tx: Prisma.TransactionClient, subject: string, policy: ProductErasurePolicy) {
  const job = await tx.productErasureJob.findUnique({ where: { subject_policyId: { subject, policyId: policy.id } } });
  if (!job?.completedAt || Date.now() < job.createdAt.getTime() + oldCredentialWindow) {
    throw new AppError('BAD_REQUEST', 409, 'PRODUCT_REJOIN_NOT_READY');
  }
  const digest = createHash('sha256').update(JSON.stringify(['rejoin', subject, job.id, policy.revision])).digest('hex');
  return { digest, impact: { name: policy.name, disclosure: 'Create fresh product access. Deleted data and prior privileges cannot be recovered.',
    containers: [], contexts: [], mode: policy.mode } };
}
export async function resumeProduct(tx: Prisma.TransactionClient, subject: string, policy: ProductErasurePolicy, digest: string) {
  if ((await rejoinPreview(tx, subject, policy)).digest !== digest || !isActiveUser(await tx.user.findUnique({ where: { id: subject } }))) {
    throw new AppError('UNAUTHORIZED', 401);
  }
  const job = await tx.productErasureJob.findUniqueOrThrow({ where: { subject_policyId: { subject, policyId: policy.id } } });
  // Clear any unfinished product login before lifting the fence. Other products' credentials,
  // including native clients on the common public OAuth domain, retain their exact scope.
  const clients = await tx.oAuthClient.findMany({ where: { nativeApp: { identifier: { in: policy.nativeApps } } }, select: { clientId: true } });
  const clientIds = { in: clients.map(c => c.clientId) };
  const domain = { in: policy.domains };
  await tx.authorizationCode.deleteMany({ where: { userId: subject, OR: [{ domain }, { oauthClientId: clientIds }] } });
  await tx.refreshToken.updateMany({ where: { userId: subject, OR: [{ domain }, { clientId: clientIds }], revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.authenticationEvidence.updateMany({ where: { userId: subject, clientDomain: domain, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.verificationToken.deleteMany({ where: { userId: subject, domain, type: { not: 'ACCOUNT_DELETION' } } });
  await tx.productErasureJob.update({ where: { id: job.id }, data: { subject: 'closed:' + job.id, rejoinedSubject: subject, rejoinedAt: new Date(), requestedContainer: Prisma.DbNull, impact: {} } });
  return { receipt: job.id, complete: true };
}
