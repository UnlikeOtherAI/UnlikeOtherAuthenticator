import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingLedgerRuntimeKeyService } from '../../services/billing-ledger-runtime-key-service';

export const billingLedgerRuntimeKeysKey = ['admin', 'billing', 'ledger-runtime-keys'] as const;
export function useBillingLedgerRuntimeKeysQuery() {
  return useQuery({ queryKey: billingLedgerRuntimeKeysKey,
    queryFn: billingLedgerRuntimeKeyService.list });
}
export function useRevokeBillingLedgerRuntimeKeyMutation() {
  const client = useQueryClient();
  return useMutation({ mutationFn: billingLedgerRuntimeKeyService.revoke,
    onSuccess: () => client.invalidateQueries({ queryKey: billingLedgerRuntimeKeysKey }) });
}
// Creation deliberately has no mutation hook: its one-time secret must never enter query caches.
