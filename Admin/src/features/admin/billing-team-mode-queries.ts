import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingTeamModeService } from '../../services/billing-team-mode-service';
import type { BillingTeamMode } from '../../schemas/billing-team-mode';

const key = (orgId: string, teamId: string) => ['admin', 'billing-team-mode', orgId, teamId];
export function useBillingTeamMode(orgId: string, teamId: string) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: key(orgId, teamId),
    queryFn: () => billingTeamModeService.read(orgId, teamId) });
  const mutation = useMutation({ mutationFn: (value: { mode: BillingTeamMode['mode']; revision: number }) =>
    billingTeamModeService.update(orgId, teamId, value.mode, value.revision),
  onSuccess: (data) => client.setQueryData(key(orgId, teamId), data),
  onError: () => client.invalidateQueries({ queryKey: key(orgId, teamId) }),
  });
  return { query, mutation };
}
