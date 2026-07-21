import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BillingAdjustmentFormValues,
  BillingAppKeyFormValues,
  BillingAssignmentFormValues,
  BillingServiceFormValues,
  BillingTariffFormValues,
} from '../../schemas/billing';
import type {
  BillingCreditAccount,
  BillingCreditAdjustmentFormValues,
} from '../../schemas/billing-credits';
import { billingAdminService } from '../../services/billing-admin-service';

const billingServicesKey = ['admin', 'billing', 'services'] as const;
export const billingCreditAccountsKey = ['admin', 'billing', 'credit-accounts'] as const;

function useRefreshBillingServices() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: billingServicesKey });
}

export function useBillingServicesQuery() {
  return useQuery({
    queryKey: billingServicesKey,
    queryFn: billingAdminService.listServices,
  });
}

export function useBillingCreditAccountsQuery(search = '') {
  return useInfiniteQuery({
    queryKey: [...billingCreditAccountsKey, { search }],
    queryFn: ({ pageParam }) =>
      billingAdminService.listCreditAccounts({
        ...(search ? { search } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.has_more ? (lastPage.next_cursor ?? undefined) : undefined,
  });
}

export function useCreateBillingServiceMutation() {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (input: BillingServiceFormValues) => billingAdminService.createService(input),
    onSuccess: refresh,
  });
}

export function useCreateBillingTariffMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (input: BillingTariffFormValues) =>
      billingAdminService.createTariff(serviceId, input),
    onSuccess: refresh,
  });
}

export function useSetDefaultBillingTariffMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (tariffId: string) => billingAdminService.setDefaultTariff(serviceId, tariffId),
    onSuccess: refresh,
  });
}

export function useSaveBillingAssignmentMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (input: BillingAssignmentFormValues) =>
      billingAdminService.saveAssignment(serviceId, input),
    onSuccess: refresh,
  });
}

export function useRemoveBillingAssignmentMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      billingAdminService.removeAssignment(serviceId, assignmentId),
    onSuccess: refresh,
  });
}

export function useCreateBillingAppKeyMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (input: BillingAppKeyFormValues) =>
      billingAdminService.createAppKey(serviceId, input),
    onSuccess: refresh,
  });
}

export function useRevokeBillingAppKeyMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (keyId: string) => billingAdminService.revokeAppKey(serviceId, keyId),
    onSuccess: refresh,
  });
}

export function useCreateBillingAdjustmentMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (input: BillingAdjustmentFormValues) =>
      billingAdminService.createAdjustment(serviceId, input),
    onSuccess: refresh,
  });
}

export function useDeactivateBillingAdjustmentMutation(serviceId: string) {
  const refresh = useRefreshBillingServices();
  return useMutation({
    mutationFn: (adjustmentId: string) =>
      billingAdminService.deactivateAdjustment(serviceId, adjustmentId),
    onSuccess: refresh,
  });
}

export function usePreviewBillingCreditAdjustmentMutation(account: BillingCreditAccount) {
  return useMutation({
    mutationFn: (input: BillingCreditAdjustmentFormValues) =>
      billingAdminService.previewCreditAdjustment(account, input),
  });
}

export function useCreateBillingCreditAdjustmentMutation(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirmationToken: string) =>
      billingAdminService.createCreditAdjustment(accountId, confirmationToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: billingCreditAccountsKey });
    },
  });
}
