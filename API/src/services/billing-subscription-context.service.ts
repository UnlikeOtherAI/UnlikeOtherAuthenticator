/** Captured local and provider identities are immutable. Keep their binding
 * inside UOA's opaque display token, never in a consumer-authored request body. */
export function billingSubscriptionContextObject(row:{id:string;customerId:string;stripeSubscriptionId:string}):string {
  return JSON.stringify(['subscription',row.id,row.customerId,row.stripeSubscriptionId]);
}
