import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  billingCreditGrantService, type BillingCreditGrantRequest,
} from '../../services/billing-credit-grant-service';

const key = (orgId: string) => ['admin', 'billing-credit-grants', orgId];

export function useBillingCreditGrants(orgId: string) {
  return useQuery({ queryKey: key(orgId), queryFn: () => billingCreditGrantService.read(orgId) });
}

export function useGrantBillingCreditsMutation(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: BillingCreditGrantRequest) => billingCreditGrantService.grant(orgId, request),
    // The balance, history and mode blockers all change; read them again.
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: key(orgId) }),
        client.invalidateQueries({ queryKey: ['admin', 'billing-organisation-mode', orgId] }),
      ]);
    },
  });
}
