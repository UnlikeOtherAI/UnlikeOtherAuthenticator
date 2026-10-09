import { createApiClient } from './api-client';
import { SmsFxPolicySchema, SmsFxPreviewSchema, SmsPoliciesSchema,
  SmsRouteImportSchema, SmsRoutePolicySchema, SmsRoutePreviewSchema,
  type SmsRouteImport } from '../schemas/billing-sms-policies';

const api = createApiClient();
const base = '/internal/admin/billing/sms-policies';
const options = { cache: 'no-store' } as const;
export const billingSmsPolicyService = {
  async list() { return SmsPoliciesSchema.parse(await api.get<unknown>(base, options)); },
  async previewFx(xml?: string) {
    return SmsFxPreviewSchema.parse(await api.post<unknown>(`${base}/fx/preview`,
      xml === undefined ? {} : { xml }, options));
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
