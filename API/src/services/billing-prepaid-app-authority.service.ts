import { Prisma, type PrismaClient } from '@prisma/client';
import type { BillingSubjectRequest } from '@unlikeotherai/billing-statement-protocol';
import { AppError } from '../utils/errors.js';
import { lockAndAssertGlobalAuthenticationEpoch } from './authentication-epoch.service.js';
import { verifyBillingActor, type BillingActor } from './billing-actor.service.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { assertActivePrepaidSubject } from './billing-prepaid-authority.service.js';

export function prepaidAppSubject(input: BillingSubjectRequest) {
  return {
    product: input.product,
    organisationId: input.organisation_id,
    teamId: input.team_id,
    userId: input.user_id,
  };
}

export async function verifyPrepaidAppActor(
  input: {
    subject: BillingSubjectRequest;
    actorToken: string;
    credential: VerifiedBillingAppKey;
    endpoint: BillingActorEndpoint;
  },
  deps?: { prisma?: PrismaClient },
): Promise<BillingActor> {
  if (input.subject.product !== input.credential.service.identifier) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_PRODUCT_MISMATCH');
  }
  return verifyBillingActor(
    {
      token: input.actorToken,
      credential: input.credential,
      endpoint: input.endpoint,
      request: prepaidAppSubject(input.subject),
    },
    deps,
  );
}

export async function lockPrepaidAppCredential(
  tx: Prisma.TransactionClient,
  credential: VerifiedBillingAppKey,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM billing_services WHERE id = ${credential.service.id} FOR SHARE`,
  );
  await tx.$queryRaw(Prisma.sql`SELECT id FROM billing_app_keys WHERE id = ${credential.id} FOR SHARE`);
  const key = await tx.billingAppKey.findFirst({
    where: {
      id: credential.id,
      purpose: credential.purpose,
      serviceId: credential.service.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      service: { active: true },
    },
    select: { id: true },
  });
  if (!key) throw new AppError('FORBIDDEN', 403, 'BILLING_APP_CREDENTIAL_REVOKED');
}

/** Lock original authority before every new monetary admission or physical dispatch. */
export async function lockPrepaidAppSubject(
  tx: Prisma.TransactionClient,
  input: {
    subject: BillingSubjectRequest;
    actor: Pick<BillingActor, 'tv' | 'exp'>;
    credential: VerifiedBillingAppKey;
  },
  requireUnexpired = true,
): Promise<void> {
  await lockAndAssertGlobalAuthenticationEpoch(
    {
      userId: input.subject.user_id,
      credentialEpoch: input.actor.tv,
    },
    { prisma: tx },
  );
  await lockPrepaidAppCredential(tx, input.credential);
  await assertActivePrepaidSubject(tx, prepaidAppSubject(input.subject), input.actor.tv);
  if (requireUnexpired && input.actor.exp * 1000 <= Date.now()) {
    throw new AppError('FORBIDDEN', 403, 'BILLING_APP_ACTOR_EXPIRED');
  }
}
