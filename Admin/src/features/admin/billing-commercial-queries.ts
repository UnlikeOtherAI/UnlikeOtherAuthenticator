import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { billingCommercialService, type ProductPolicyInput } from '../../services/billing-commercial-service';
export function useSeatOffers(id: string) {
  return useQuery({ queryKey: ['billing', 'seat-offers', id], queryFn: () => billingCommercialService.seatOffers(id) });
}
export function usePublishSeatOffer(id: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (tariffId: string) => billingCommercialService.publishSeatOffer(id, tariffId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['billing', 'seat-offers', id] }) });
}
export function useWithdrawSeatOffer(id: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (offerId: string) => billingCommercialService.withdrawSeatOffer(id, offerId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['billing', 'seat-offers', id] }) });
}
export function useProductPolicies(id: string) {
  return useQuery({ queryKey: ['billing', 'product-policy', id], queryFn: () => billingCommercialService.policies(id) });
}
export function useSaveProductPolicy(id: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: ProductPolicyInput) => billingCommercialService.savePolicy(id, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['billing', 'product-policy', id] }) });
}
export function useStorageCatalogs(id: string) {
  return useQuery({ queryKey: ['billing', 'storage-catalog', id], queryFn: () => billingCommercialService.catalogs(id) });
}
export function useBindStorageCatalog(id: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: { currency: 'EUR' | 'GBP' | 'USD'; price_id: string }) => billingCommercialService.bindCatalog(id, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ['billing', 'storage-catalog', id] }) });
}
