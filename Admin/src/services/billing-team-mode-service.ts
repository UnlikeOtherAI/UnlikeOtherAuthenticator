import { BillingTeamModeSchema, type BillingTeamMode } from '../schemas/billing-team-mode';
import { createApiClient } from './api-client';

const api = createApiClient();
const path = (orgId: string, teamId: string) =>
  `/internal/admin/billing/organisations/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/mode`;
export const billingTeamModeService = {
  async read(orgId: string, teamId: string) {
    return BillingTeamModeSchema.parse(await api.get<unknown>(path(orgId, teamId), { cache: 'no-store' }));
  },
  async update(orgId: string, teamId: string, mode: BillingTeamMode['mode'], revision: number) {
    return BillingTeamModeSchema.parse(await api.put<unknown>(path(orgId, teamId), {
      mode, expected_revision: revision,
    }, { cache: 'no-store' }));
  },
};
