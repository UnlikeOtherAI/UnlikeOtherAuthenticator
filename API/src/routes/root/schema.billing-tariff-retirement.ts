import type { EndpointSchema } from './schema.js';

const path = '/internal/admin/billing/services/:serviceId/tariffs/:tariffId';
const auth = 'Current admin-domain platform SUPERUSER';
const response = {
  200: 'The serialised tariff, including retired_at and retire_blocked_by',
  404: 'BILLING_TARIFF_NOT_FOUND: the tariff is not in that product',
};
export const billingTariffRetirementEndpoints: EndpointSchema[] = [
  {
    method: 'POST',
    path: `${path}/retire`,
    auth,
    description:
      'Retire a tariff version, a soft delete. Nobody can be given it any more (default, assignment, ' +
      'contract term, checkout); every month and record that already names it keeps resolving it. ' +
      'Idempotent. Refused while retire_blocked_by is non-empty: default, assignments, subscriptions, contract_terms.',
    response: { ...response, 409: 'BILLING_TARIFF_IN_USE: a blocker applies' },
  },
  {
    method: 'POST',
    path: `${path}/restore`,
    auth,
    description: 'Make a retired tariff version available again. Idempotent.',
    response,
  },
];
