import { createApiClient } from './api-client';
import { SmsCountryAcceptedSchema, SmsCountryPreviewSchema, SmsFxPolicySchema, SmsFxPreviewSchema, SmsPoliciesSchema,
  SmsRouteImportSchema, SmsRoutePolicySchema, SmsRoutePreviewSchema,
  SmsMonthlyPriceInputSchema, SmsMonthlyPriceSchema, type SmsMonthlyPriceInput,
  type SmsRouteImport } from '../schemas/billing-sms-policies';

const api = createApiClient();
const base = '/internal/admin/billing/sms-policies';
const options = { cache: 'no-store' } as const;
export const billingSmsPolicyService = {
  async monthlyPrice() {
    return SmsMonthlyPriceSchema.parse(await api.get<unknown>(`${base}/monthly-price`, options));
  },
  async setMonthlyPrice(input: SmsMonthlyPriceInput) {
    return SmsMonthlyPriceSchema.parse(await api.post<unknown>(`${base}/monthly-price`,
      SmsMonthlyPriceInputSchema.parse(input), options));
  },
  async list() { return SmsPoliciesSchema.parse(await api.get<unknown>(base, options)); },
  async previewFx(xml?: string) {
    return SmsFxPreviewSchema.parse(await api.post<unknown>(`${base}/fx/preview`,
      xml === undefined ? {} : { xml }, options));
  },
  /** Refresh and accept: the server applies the renewal band and writes the reason. */
  async refreshAcceptFx() {
    return SmsFxPolicySchema.parse(await api.post<unknown>(`${base}/fx/refresh-accept`,
      { policy_understood: true }, options));
  },
  async previewCountry(country: string) {
    return SmsCountryPreviewSchema.parse(await api.post<unknown>(`${base}/routes/country/preview`,
      { country }, options));
  },
  /** One Accept records all three attestations; the server writes the reason. */
  async acceptCountry(token: string) {
    return SmsCountryAcceptedSchema.parse(await api.post<unknown>(`${base}/routes/country/accept`, {
      preview_token: token, policy_understood: true, complete_segment_bound: true, complete_message_bound: true,
    }, options));
  },
  async previewRoute(input: SmsRouteImport) {
    return SmsRoutePreviewSchema.parse(await api.post<unknown>(`${base}/routes/preview`,
      SmsRouteImportSchema.parse(input), options));
  },
  async acceptFx(token: string, reason: string) {
    return SmsFxPolicySchema.parse(await api.post<unknown>(`${base}/fx/accept`, {
      preview_token: token, acceptance_reason: reason, policy_understood: true,
    }, options));
  },
  async acceptRoute(token: string, reason: string) {
    return SmsRoutePolicySchema.parse(await api.post<unknown>(`${base}/routes/accept`, {
      preview_token: token, acceptance_reason: reason, policy_understood: true,
      complete_segment_bound: true, complete_message_bound: true,
    }, options));
  },
};
