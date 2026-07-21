import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  BillingContractFormValues,
  BillingContractVersionFormValues,
  BillingInvoiceBuyerFormValues,
  BillingInvoiceCalculateFormValues,
  BillingInvoiceIssuerFormValues,
  BillingInvoicePaymentFormValues,
} from '../../schemas/billing-contracts';
import { billingContractAdminService } from '../../services/billing-contract-admin-service';

const contractsKey = ['admin', 'billing', 'contracts'] as const;
const issuersKey = ['admin', 'billing', 'invoice-issuers'] as const;
const invoicesKey = ['admin', 'billing', 'invoices'] as const;

function useRefresh(keys: ReadonlyArray<readonly unknown[]>) {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
}

export function useBillingContractsQuery() {
  return useQuery({
    queryKey: contractsKey,
    queryFn: () => billingContractAdminService.listContracts(),
  });
}

export function useBillingInvoiceIssuersQuery() {
  return useQuery({
    queryKey: issuersKey,
    queryFn: billingContractAdminService.listIssuerProfiles,
  });
}

export function useBillingInvoicesQuery() {
  return useQuery({ queryKey: invoicesKey, queryFn: billingContractAdminService.listInvoices });
}

export function useBillingInvoiceBuyerQuery(organisationId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'billing', 'invoice-buyer', organisationId],
    queryFn: () => billingContractAdminService.getBuyerProfile(organisationId),
    enabled: enabled && Boolean(organisationId),
    retry: false,
  });
}

export function useCreateBillingContractMutation() {
  const refresh = useRefresh([contractsKey]);
  return useMutation({
    mutationFn: (input: BillingContractFormValues) =>
      billingContractAdminService.createContract(input),
    onSuccess: refresh,
  });
}

export function useCreateBillingContractVersionMutation(contractId: string) {
  const refresh = useRefresh([contractsKey]);
  return useMutation({
    mutationFn: (input: BillingContractVersionFormValues) =>
      billingContractAdminService.createVersion(contractId, input),
    onSuccess: refresh,
  });
}

export function useActivateBillingContractVersionMutation(contractId: string, versionId: string) {
  const refresh = useRefresh([contractsKey]);
  return useMutation({
    mutationFn: (services: Array<{ serviceId: string; monthlyAmountMinor: string }>) =>
      billingContractAdminService.activateVersion(contractId, versionId, services),
    onSuccess: refresh,
  });
}

export function useCreateBillingInvoiceIssuerMutation() {
  const refresh = useRefresh([issuersKey]);
  return useMutation({
    mutationFn: (input: BillingInvoiceIssuerFormValues) =>
      billingContractAdminService.createIssuerProfile(input),
    onSuccess: refresh,
  });
}

export function useSaveBillingInvoiceBuyerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BillingInvoiceBuyerFormValues) =>
      billingContractAdminService.saveBuyerProfile(input),
    onSuccess: (profile) =>
      queryClient.setQueryData(
        ['admin', 'billing', 'invoice-buyer', profile.organisation_id],
        profile,
      ),
  });
}

export function useCalculateBillingInvoiceMutation() {
  const refresh = useRefresh([invoicesKey]);
  return useMutation({
    mutationFn: (input: BillingInvoiceCalculateFormValues) =>
      billingContractAdminService.calculateInvoice(input),
    onSuccess: refresh,
  });
}

function useRefreshInvoicesMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const refresh = useRefresh([invoicesKey]);
  return useMutation({ mutationFn, onSuccess: refresh });
}

export function useIssueBillingInvoiceMutation() {
  return useRefreshInvoicesMutation((invoiceId: string) =>
    billingContractAdminService.issueInvoice(invoiceId),
  );
}

export function useVoidBillingInvoiceMutation() {
  return useRefreshInvoicesMutation((input: { invoiceId: string; reason: string }) =>
    billingContractAdminService.voidInvoice(input.invoiceId, input.reason),
  );
}

export function useRecordBillingInvoicePaymentMutation() {
  return useRefreshInvoicesMutation(
    (input: { invoiceId: string; values: BillingInvoicePaymentFormValues }) =>
      billingContractAdminService.recordPayment(input.invoiceId, input.values),
  );
}
