import {
  BillingAppKeySchema,
  CreatedBillingAdjustmentSchema,
  BillingAssignmentSchema,
  BillingServicesSchema,
  BillingServiceSchema,
  BillingTariffSchema,
  CreatedBillingAppKeySchema,
  type BillingAppKeyFormValues,
  type BillingAdjustmentFormValues,
  type BillingAssignmentFormValues,
  type BillingServiceFormValues,
  type BillingTariffFormValues,
} from '../schemas/billing';
import {
  BillingCreditAccountsResponseSchema,
  BillingCreditAdjustmentResponseSchema,
  type BillingCreditAccount,
  type BillingCreditAdjustmentFormValues,
} from '../schemas/billing-credits';
import { createApiClient } from './api-client';

const api = createApiClient();

function tariffBody(input: BillingTariffFormValues | BillingServiceFormValues) {
  return {
    key: input.key,
    name: input.name,
    mode: input.mode,
    collection_mode: input.collectionMode,
    markup_bps: input.markupBps,
    monthly_subscription: {
      amount_minor: input.monthlyAmountMinor,
      currency: input.currency,
    },
  };
}

function parsePublicJwk(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Actor public JWK must be a valid JSON object.');
  }
}

function returnOrigins(value: string): string[] {
  const origins = value
    .split(/[\n,]/)
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin.replace(/\/$/, '')) {
      throw new Error('Checkout return origins must be HTTPS origins without paths.');
    }
  }
  return [...new Set(origins.map((origin) => origin.replace(/\/$/, '')))];
}

export const billingAdminService = {
  async listServices() {
    return BillingServicesSchema.parse(await api.get<unknown>('/internal/admin/billing/services'));
  },

  async createService(input: BillingServiceFormValues) {
    return BillingServiceSchema.parse(
      await api.post<unknown>('/internal/admin/billing/services', {
        identifier: input.identifier,
        name: input.serviceName,
        default_tariff: tariffBody(input),
      }),
    );
  },

  async createTariff(serviceId: string, input: BillingTariffFormValues) {
    return BillingTariffSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/tariffs`,
        {
          ...tariffBody(input),
          set_as_default: input.setAsDefault,
        },
      ),
    );
  },

  async setDefaultTariff(serviceId: string, tariffId: string) {
    return BillingTariffSchema.parse(
      await api.put<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/default-tariff`,
        { tariff_id: tariffId },
      ),
    );
  },

  async saveAssignment(serviceId: string, input: BillingAssignmentFormValues) {
    return BillingAssignmentSchema.parse(
      await api.put<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/assignments`,
        {
          tariff_id: input.tariffId,
          organisation_id: input.organisationId,
          team_id: input.teamId || null,
        },
      ),
    );
  },

  async removeAssignment(serviceId: string, assignmentId: string): Promise<void> {
    await api.delete<unknown>(
      `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/assignments/${encodeURIComponent(assignmentId)}`,
    );
  },

  async createAppKey(serviceId: string, input: BillingAppKeyFormValues) {
    return CreatedBillingAppKeySchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/app-keys`,
        {
          purpose: input.purpose,
          name: input.name,
          actor_issuer: input.actorIssuer,
          actor_audience: input.actorAudience,
          actor_public_jwk: parsePublicJwk(input.actorPublicJwkJson),
          checkout_return_origins: returnOrigins(input.checkoutReturnOrigins),
          expires_at: input.expiresAt
            ? new Date(`${input.expiresAt}T23:59:59`).toISOString()
            : null,
        },
      ),
    );
  },

  async listAppKeys(serviceId: string) {
    return BillingAppKeySchema.array().parse(
      await api.get<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/app-keys`,
      ),
    );
  },

  async revokeAppKey(serviceId: string, keyId: string): Promise<void> {
    await api.delete<unknown>(
      `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/app-keys/${encodeURIComponent(keyId)}`,
    );
  },

  async createAdjustment(serviceId: string, input: BillingAdjustmentFormValues) {
    return CreatedBillingAdjustmentSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/adjustments`,
        {
          organisation_id: input.organisationId,
          team_id: input.teamId || null,
          key: input.key,
          name: input.name,
          kind: input.kind,
          cadence: input.cadence,
          amount_minor: input.amountMinor,
          currency: input.currency,
          starts_at: new Date(`${input.startsAt}T00:00:00.000Z`).toISOString(),
          ends_at: input.endsAt ? new Date(`${input.endsAt}T00:00:00.000Z`).toISOString() : null,
        },
      ),
    );
  },

  async deactivateAdjustment(serviceId: string, adjustmentId: string): Promise<void> {
    await api.delete<unknown>(
      `/internal/admin/billing/services/${encodeURIComponent(serviceId)}/adjustments/${encodeURIComponent(adjustmentId)}`,
    );
  },

  async listCreditAccounts(): Promise<BillingCreditAccount[]> {
    const response = BillingCreditAccountsResponseSchema.parse(
      await api.get<unknown>('/internal/admin/billing/credit-accounts'),
    );
    return response.accounts;
  },

  async createCreditAdjustment(
    account: Pick<BillingCreditAccount, 'id' | 'organisation' | 'team'>,
    input: BillingCreditAdjustmentFormValues,
  ) {
    return BillingCreditAdjustmentResponseSchema.parse(
      await api.post<unknown>(
        `/internal/admin/billing/credit-accounts/${encodeURIComponent(account.id)}/adjustments`,
        {
          organisation_id: account.organisation.id,
          team_id: account.team.id,
          signed_credits: input.signedCredits,
          reason: input.reason,
          idempotency_key: input.idempotencyKey,
        },
      ),
    );
  },
};
