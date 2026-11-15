import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createApiClient } from '../../services/api-client';
const api = createApiClient();
const Policy = z.object({
  policy_id: z.string(),
  project_id: z.string().uuid(),
  currency: z.literal('USD'),
  provider_price_per_hour: z.string(),
  customer_price_per_minute: z.string(),
  markup_bps: z.literal(1000),
  minimum_seconds: z.literal(60),
  rounding_seconds: z.literal(60),
  valid_until: z.string(),
  source_url: z.string(),
  retired_at: z.string().nullable(),
  created_at: z.string(),
});
const List = z.object({ policies: z.array(Policy), pending: z.number(), reconciliation: z.number() });
export type BrowserPolicyForm = {
  project_id: string;
  provider_price_per_hour: string;
  rounding_seconds: 60;
  source_url: string;
  valid_until: string;
  expected_policy_id: string | null;
};
const path = (serviceId: string) =>
  `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/browser-policies`;
const key = (serviceId: string) => ['admin', 'billing', serviceId, 'browser-policies'];
export function useBrowserPolicies(serviceId: string) {
  return useQuery({
    queryKey: key(serviceId),
    queryFn: async () => List.parse(await api.get(path(serviceId))),
  });
}
export function usePublishBrowserPolicy(serviceId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: (input: BrowserPolicyForm) => api.post(path(serviceId), input),
    onSuccess: () => queries.invalidateQueries({ queryKey: key(serviceId) }),
  });
}
