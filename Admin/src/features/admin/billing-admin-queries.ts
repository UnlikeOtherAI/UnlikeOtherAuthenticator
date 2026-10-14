import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BillingAdjustmentFormValues,
  BillingAppKeyFormValues,
  CreatedBillingAppKey,
  BillingAssignmentFormValues,
  BillingServiceFormValues,
  BillingTariffFormValues,
} from '../../schemas/billing';
import { billingAdminService } from '../../services/billing-admin-service';
import { useAsyncDeliveryScope } from '../../utils/use-async-delivery-scope';

const billingServicesKey = ['admin', 'billing', 'services'] as const;

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

export function useCreateBillingAppKeyMutation(
  serviceId: string,
  onCreated: (key: CreatedBillingAppKey) => void,
  open = true,
) {
  const refresh = useRefreshBillingServices();
  const captureDelivery = useAsyncDeliveryScope(open ? serviceId : null);
  return useMutation({
    gcTime: 0,
    mutationFn: async (input: BillingAppKeyFormValues) => {
      const canDeliver = captureDelivery();
      const key = await billingAdminService.createAppKey(serviceId, input);
      if (canDeliver()) onCreated(key);
    },
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
