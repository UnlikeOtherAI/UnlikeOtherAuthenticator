import { createApiClient } from './api-client';
import { AuthFunnelSummarySchema } from '../schemas/auth-funnel';

const api = createApiClient();

export type AuthFunnelFilters = { from?: string; to?: string; domain?: string };

export const authFunnelService = {
  async get(filters: AuthFunnelFilters) {
    const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const suffix = query.size ? `?${query}` : '';
    return AuthFunnelSummarySchema.parse(await api.get<unknown>(`/internal/admin/auth-funnel${suffix}`));
  },
};
