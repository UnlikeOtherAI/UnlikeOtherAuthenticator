import {
  BillingCreditGrantResultSchema, BillingOrganisationCreditGrantsSchema,
} from '../schemas/billing-credit-grants';
import { createApiClient } from './api-client';

const api = createApiClient();
const path = (orgId: string) =>
  `/internal/admin/billing/organisations/${encodeURIComponent(orgId)}/credit-grants`;

export type BillingCreditGrantRequest = { credits: string; reason: string; idempotencyKey: string };

export const billingCreditGrantService = {
  async read(orgId: string) {
    return BillingOrganisationCreditGrantsSchema.parse(
      await api.get<unknown>(path(orgId), { cache: 'no-store' }));
  },
  async grant(orgId: string, request: BillingCreditGrantRequest) {
    return BillingCreditGrantResultSchema.parse(await api.post<unknown>(path(orgId), {
      credits: request.credits, reason: request.reason.trim(), idempotency_key: request.idempotencyKey,
    }, { cache: 'no-store' }));
  },
};
