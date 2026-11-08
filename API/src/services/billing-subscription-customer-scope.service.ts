import { AppError } from '../utils/errors.js';

/** A provider constraint, not another payer. One ORG wallet/financial scope can
 * have subscription customers in multiple currencies. Captured customer IDs
 * are never rewritten; funding and SMS retain their separate existing keys. */
export function organisationSubscriptionCustomerScopeKey(organisationId:string,currency:string):string {
  if(!/^[A-Z]{3}$/.test(currency))throw new AppError('BAD_REQUEST',409,'STRIPE_SUBSCRIPTION_CURRENCY_INVALID');
  return `${organisationId}:billing:${currency}`;
}
