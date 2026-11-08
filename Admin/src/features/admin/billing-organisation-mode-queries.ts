import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingOrganisationModeService } from '../../services/billing-organisation-mode-service';
import type { BillingOrganisationMode } from '../../schemas/billing-organisation-mode';

const key = (orgId: string) => ['admin', 'billing-organisation-mode', orgId];
export function useBillingOrganisationMode(orgId: string) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: key(orgId),
    queryFn: () => billingOrganisationModeService.read(orgId) });
  const mutation = useMutation({ mutationFn: (value: { mode: BillingOrganisationMode['mode']; revision: number }) =>
    billingOrganisationModeService.update(orgId, value.mode, value.revision),
  onSuccess: (data) => client.setQueryData(key(orgId), data),
  onError: () => client.invalidateQueries({ queryKey: key(orgId) }),
  });
  return { query, mutation };
}
