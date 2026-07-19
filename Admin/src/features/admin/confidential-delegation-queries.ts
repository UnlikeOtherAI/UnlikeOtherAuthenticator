import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  confidentialDelegationService,
  type ConfidentialDelegationUpdate,
} from '../../services/confidential-delegation-service';
import type { ConfidentialDelegationFormValues } from '../../schemas/confidential-delegation';

const queryKey = ['admin', 'confidential-delegations'] as const;

export function useConfidentialDelegationsQuery() {
  return useQuery({
    queryKey,
    queryFn: confidentialDelegationService.list,
  });
}

export function useCreateConfidentialDelegationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ConfidentialDelegationFormValues) =>
      confidentialDelegationService.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useUpdateConfidentialDelegationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      mappingId,
      input,
    }: {
      mappingId: string;
      input: ConfidentialDelegationUpdate;
    }) => confidentialDelegationService.update(mappingId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export function useDeleteConfidentialDelegationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: confidentialDelegationService.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
}
