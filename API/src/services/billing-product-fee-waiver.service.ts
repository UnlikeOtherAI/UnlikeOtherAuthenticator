import type { PrismaClient } from '@prisma/client';

export type ProductFeeWaiver = { id: string; startsAt: Date; endsAt: Date };

/** Historical immutable policy revisions determine fee waiver intervals. */
export async function productFeeWaivers(prisma: PrismaClient, input: {
  serviceId: string; organisationId: string; startsAt: Date; endsAt: Date;
}): Promise<ProductFeeWaiver[]> {
  const enrollment = await prisma.billingProductEnrollment.findUnique({ where: {
    serviceId_orgId: { serviceId: input.serviceId, orgId: input.organisationId },
  } });
  if (!enrollment) return [];
  const policies = await prisma.billingProductPolicyRevision.findMany({ where: {
    enrollmentId: enrollment.id, effectiveAt: { lt: input.endsAt },
  }, orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
  const terms = await prisma.billingTariffTermEvent.findMany({ where: { serviceId: input.serviceId,
    source: 'ORGANISATION', scopeKey: input.organisationId },
    orderBy: [{ effectiveFromMonth: 'asc' }, { sequence: 'asc' }] });
  return policies.flatMap((policy, index) => {
    const next = policies[index + 1]?.effectiveAt ?? input.endsAt;
    let from = Math.max(input.startsAt.getTime(), policy.effectiveAt.getTime());
    let to = Math.min(input.endsAt.getTime(), next.getTime());
    const bindingIndex = policy.privateTermEventId ? terms.findIndex((term) => term.id === policy.privateTermEventId) : -1;
    if (policy.privateAtCost) {
      if (bindingIndex < 0) return [];
      const nextTerm = terms[bindingIndex + 1];
      if (nextTerm) to = Math.min(to, Date.parse(`${nextTerm.effectiveFromMonth}-01T00:00:00.000Z`));
    } else {
      if (!policy.trialStartsAt || !policy.trialEndsAt) return [];
      from = Math.max(from, policy.trialStartsAt.getTime());
      to = Math.min(to, policy.trialEndsAt.getTime());
    }
    return from < to ? [{ id: policy.id, startsAt: new Date(from), endsAt: new Date(to) }] : [];
  });
}

export function unwaivedIntervals(from: Date, to: Date, waivers: ProductFeeWaiver[]) {
  const spans = waivers.map((waiver) => ({ from: Math.max(from.getTime(), waiver.startsAt.getTime()),
    to: Math.min(to.getTime(), waiver.endsAt.getTime()) })).filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
  let cursor = from.getTime();
  const paid: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const span of spans) {
    if (span.from > cursor) paid.push({ startsAt: new Date(cursor), endsAt: new Date(span.from) });
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < to.getTime()) paid.push({ startsAt: new Date(cursor), endsAt: new Date(to) });
  return paid;
}
