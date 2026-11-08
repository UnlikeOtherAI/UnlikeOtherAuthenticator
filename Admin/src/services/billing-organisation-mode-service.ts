import { BillingOrganisationModeSchema, type BillingOrganisationMode } from '../schemas/billing-organisation-mode';
import { createApiClient } from './api-client';

const api = createApiClient();
const path = (orgId: string) =>
  `/internal/admin/billing/organisations/${encodeURIComponent(orgId)}/mode`;
export const billingOrganisationModeService = {
  async read(orgId: string) {
    return BillingOrganisationModeSchema.parse(await api.get<unknown>(path(orgId), { cache: 'no-store' }));
  },
  async update(orgId: string, mode: BillingOrganisationMode['mode'], revision: number) {
    return BillingOrganisationModeSchema.parse(await api.put<unknown>(path(orgId), {
      mode, expected_revision: revision,
    }, { cache: 'no-store' }));
  },
};
