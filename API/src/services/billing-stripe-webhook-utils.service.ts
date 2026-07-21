import type Stripe from 'stripe';

export function stripeExternalId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown };
  };
  return (
    candidate.code === 'resource_missing' ||
    candidate.raw?.code === 'resource_missing' ||
    candidate.statusCode === 404
  );
}

export async function retrieveStripeSubscription(
  stripe: Pick<Stripe, 'subscriptions'>,
  subscriptionId: string,
): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (isMissingStripeResource(error)) return null;
    throw error;
  }
}
