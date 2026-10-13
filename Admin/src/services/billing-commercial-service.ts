import { z } from 'zod';
import { createApiClient } from './api-client';
const api = createApiClient();
const policies = z.array(z.object({ id: z.string(), organisation_id: z.string(), source_domain: z.string(),
  billing_timezone: z.string(), active: z.boolean(), policy: z.object({ id: z.string(), privateAtCost: z.boolean(),
    effectiveAt: z.string(), trialStartsAt: z.string().nullable(), trialEndsAt: z.string().nullable() }).nullable() }));
const catalogs = z.array(z.object({ id: z.string(), account_id: z.string(), currency: z.string(),
  unit_amount_minor: z.string(), price_id: z.string(), version: z.number() }));
const seatOffers = z.array(z.object({ id: z.string(), tariff_id: z.string(), currency: z.string(),
  unit_amount_minor: z.string(), usage_currency: z.string(), published_at: z.string(), withdrawn_at: z.string().nullable() }));
const path = (id: string) => `/internal/admin/billing/services/${encodeURIComponent(id)}`;
export type ProductPolicyInput = { organisation_id: string; source_domain: string; billing_timezone: string;
  private_at_cost: boolean; start_trial: boolean; trial_ends_at?: string };
export const billingCommercialService = {
  async seatOffers(id: string) { return seatOffers.parse(await api.get<unknown>(`${path(id)}/seat-offers`)); },
  async publishSeatOffer(id: string, tariff_id: string) { await api.post<unknown>(`${path(id)}/seat-offers`, { tariff_id }); },
  async withdrawSeatOffer(id: string, offerId: string) { await api.post<unknown>(`${path(id)}/seat-offers/${encodeURIComponent(offerId)}/withdraw`, {}); },
  async policies(id: string) { return policies.parse(await api.get<unknown>(`${path(id)}/product-policies`)); },
  async savePolicy(id: string, input: ProductPolicyInput) {
    return z.object({ id: z.string(), effective_at: z.string() }).parse(await api.post<unknown>(`${path(id)}/product-policies`, input));
  },
  async catalogs(id: string) { return catalogs.parse(await api.get<unknown>(`${path(id)}/storage-catalogs`)); },
  async bindCatalog(id: string, input: { currency: 'EUR' | 'GBP' | 'USD'; price_id: string }) {
    await api.post<unknown>(`${path(id)}/storage-catalogs`, input);
  },
};
