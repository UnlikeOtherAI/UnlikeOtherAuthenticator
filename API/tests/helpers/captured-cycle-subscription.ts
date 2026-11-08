import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/** Opening historical fixture only. Production cycle and recovery calls run
 * after this transaction with all financial guards enabled. */
export async function importCapturedCycleSubscription(prisma: PrismaClient, input: {
  orgId: string; teamId: string; serviceId: string; tariffId: string;
  accountId: string; customerId: string; appKeyId: string; userId: string;
}) {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const { userId, ...scope } = input;
    const checkout = await tx.billingStripeCheckoutSession.create({ data: {
      ...scope, createdAt: new Date('2026-01-01T00:00:00Z'),
      tariffSource: 'SERVICE_DEFAULT', scope: 'TEAM',
      scopeKey: `${input.orgId}:${input.teamId}`, actorJti: randomUUID(),
      requestedByUserId: userId, successUrlDigest: 'a'.repeat(64),
      cancelUrlDigest: 'b'.repeat(64), leaseExpiresAt: new Date('2026-08-01T00:00:00Z'),
    } });
    const { appKeyId: _appKeyId, ...subscriptionScope } = scope;
    return tx.billingStripeSubscription.create({ data: {
      ...subscriptionScope, checkoutId: checkout.id,
      createdAt: new Date('2026-01-01T00:00:00Z'), tariffSource: 'SERVICE_DEFAULT',
      scope: 'TEAM', scopeKey: `${input.orgId}:${input.teamId}`,
      stripeSubscriptionId: `sub_${randomUUID()}`, stripeUsageItemId: `si_${randomUUID()}`,
      status: 'active', livemode: false,
    } });
  });
}
