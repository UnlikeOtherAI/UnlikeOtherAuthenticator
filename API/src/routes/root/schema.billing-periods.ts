import type { EndpointSchema } from './schema.js';

const path = '/internal/admin/billing/services/:serviceId/period-settings';
const periods = {
  seat_trial_hours: 'Integer 1–8760. Length of the free seat trial for a new or newly paid organisation',
  seat_renewal_grace_hours:
    'Integer 1–720. Monday–Friday hours an organisation keeps access after a failed seat renewal',
};
export const billingPeriodEndpoints: EndpointSchema[] = [
  {
    method: 'GET',
    path,
    auth: 'Current admin-domain platform SUPERUSER',
    description:
      'Read the commercial periods of one product. A product nobody has edited returns the defaults (168 and 24) with updated_at null.',
    response: { 200: 'seat_trial_hours, seat_renewal_grace_hours, updated_at; private/no-store', 404: 'Unknown product' },
  },
  {
    method: 'PUT',
    path,
    auth: 'Current admin-domain platform SUPERUSER, rechecked under transaction locks',
    description:
      'Set both periods. A change applies to trials and grace periods that start afterwards; one already running keeps its deadline.',
    body: periods,
    response: { 200: 'The saved periods and updated_at', 400: 'A value outside its range', 404: 'Unknown product' },
  },
];
