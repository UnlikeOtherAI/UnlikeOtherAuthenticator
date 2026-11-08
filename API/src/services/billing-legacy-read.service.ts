import { authorizeBillingCycle,type BillingCycleSubject } from './billing-cycle-authority.service.js';
import type { BillingActorEndpoint } from './billing-actor-audience.service.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import { AppError } from '../utils/errors.js';

/** A former team aggregate cannot stand in for independently verified ORG
 * sections. Authenticate first; preserve the session and require the org read. */
export async function requireOrganisationBillingOverview(context:{credential:VerifiedBillingAppKey;
  actorToken:string;endpoint:BillingActorEndpoint;request:BillingCycleSubject}):Promise<never> {
  await authorizeBillingCycle(context);
  throw new AppError('BAD_REQUEST',409,'BILLING_ORGANISATION_OVERVIEW_REQUIRED');
}
