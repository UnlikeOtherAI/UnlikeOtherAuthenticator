import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

export function useBillingCreditAccountsQuery() {
  return useQuery({
    queryKey: billingCreditAccountsKey,
    queryFn: billingAdminService.listCreditAccounts,
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

export function useCreateBillingCreditAdjustmentMutation(account: BillingCreditAccount) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BillingCreditAdjustmentFormValues) =>
      billingAdminService.createCreditAdjustment(account, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: billingCreditAccountsKey });
    },
  });
}
