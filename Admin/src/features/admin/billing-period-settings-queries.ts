import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createApiClient } from '../../services/api-client';
const api = createApiClient();
const Settings = z.object({
  seat_trial_hours: z.number().int(),
  seat_renewal_grace_hours: z.number().int(),
  updated_at: z.string().nullable(),
});
export type BillingPeriodSettingsForm = { seat_trial_hours: number; seat_renewal_grace_hours: number };
const path = (serviceId: string) =>
  `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/period-settings`;
const key = (serviceId: string) => ['admin', 'billing', serviceId, 'period-settings'];
export function useBillingPeriodSettings(serviceId: string) {
  return useQuery({
    queryKey: key(serviceId),
    queryFn: async () => Settings.parse(await api.get(path(serviceId))),
  });
}
export function useSaveBillingPeriodSettings(serviceId: string) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: BillingPeriodSettingsForm) => Settings.parse(await api.put(path(serviceId), input)),
    onSuccess: (saved) => queries.setQueryData(key(serviceId), saved),
  });
}
