import { Prisma } from '@prisma/client';
import type { BillingSubjectRequest } from '@unlikeotherai/billing-statement-protocol';
import { AppError } from '../utils/errors.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import { verifyBillingActor, type BillingActor } from './billing-actor.service.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { assertActivePrepaidSubject } from './billing-prepaid-authority.service.js';
import { isBillingManager } from './billing-stripe-manager.service.js';

export async function assertSmsTeamManager(tx: Prisma.TransactionClient, subject: BillingSubjectRequest): Promise<void> {
  const [org, team] = await Promise.all([
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId: subject.organisation_id, userId: subject.user_id } },
      select: { role: true } }),
    tx.teamMember.findUnique({ where: { teamId_userId: { teamId: subject.team_id, userId: subject.user_id } },
      select: { teamRole: true } }),
  ]);
  if (!org || !isBillingManager({ scope: 'TEAM', orgRole: org.role, teamRole: team?.teamRole })) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_MANAGEMENT_NOT_AUTHORIZED');
  }
}

export function smsSubject(input: BillingSubjectRequest) {
  return { product: input.product, organisationId: input.organisation_id,
    teamId: input.team_id, userId: input.user_id };
}

export async function verifySmsActor(input: {
  subject: BillingSubjectRequest; actorToken: string;
  credential: VerifiedBillingAppKey; endpoint: BillingActorEndpoint;
}): Promise<BillingActor> {
  if (input.subject.product !== input.credential.service.identifier) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  return verifyBillingActor({ token: input.actorToken, credential: input.credential,
    endpoint: input.endpoint, request: smsSubject(input.subject) });
}

export async function lockSmsCredential(tx: Prisma.TransactionClient,
  credential: VerifiedBillingAppKey): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_services WHERE id = ${credential.service.id} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_app_keys WHERE id = ${credential.id} FOR SHARE`);
  const key = await tx.billingAppKey.findFirst({ where: {
    id: credential.id, purpose: credential.purpose, serviceId: credential.service.id,
    revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    service: { active: true },
  }, select: { id: true } });
  if (!key) throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_CREDENTIAL_REVOKED');
}

/** Lock original authority before every new monetary admission or physical dispatch. */
export async function lockSmsSubject(tx: Prisma.TransactionClient, input: {
  subject: BillingSubjectRequest; actor: Pick<BillingActor, 'tv' | 'exp'>;
  credential: VerifiedBillingAppKey;
}, requireUnexpired = true): Promise<void> {
  await lockAndAssertGlobalAuthenticationEpoch({
    userId: input.subject.user_id, credentialEpoch: input.actor.tv,
  }, { prisma: tx });
  await lockSmsCredential(tx, input.credential);
  await assertActivePrepaidSubject(tx, smsSubject(input.subject), input.actor.tv);
  if (requireUnexpired && input.actor.exp * 1000 <= Date.now()) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_SMS_ACTOR_EXPIRED');
  }
}
