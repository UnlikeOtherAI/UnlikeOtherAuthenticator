import type { BillingAppKeyRecord } from '../../../services/billing-app-key.service.js';

type Tariff = {
  id: string;
  serviceId: string;
  key: string;
  version: number;
  name: string;
  mode: string;
  markupBps: number;
  monthlyAmountMinor: bigint;
  currency: string;
  isDefault: boolean;
  createdByEmail: string | null;
  createdAt: Date;
};

export function serializeBillingTariff(tariff: Tariff) {
  return {
    id: tariff.id,
    service_id: tariff.serviceId,
    key: tariff.key,
    version: tariff.version,
    name: tariff.name,
    mode: tariff.mode.toLowerCase(),
    markup_bps: tariff.markupBps,
    monthly_subscription: {
      amount_minor: tariff.monthlyAmountMinor.toString(),
      currency: tariff.currency,
    },
    is_default: tariff.isDefault,
    created_by_email: tariff.createdByEmail,
    created_at: tariff.createdAt.toISOString(),
  };
}

export function serializeBillingAppKey(record: BillingAppKeyRecord) {
  return {
    id: record.id,
    service_id: record.serviceId,
    name: record.name,
    key_prefix: record.keyPrefix,
    actor_issuer: record.actorIssuer,
    actor_audience: record.actorAudience,
    actor_key_id: record.actorKeyId,
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    expires_at: record.expiresAt?.toISOString() ?? null,
    revoked_at: record.revokedAt?.toISOString() ?? null,
    created_by_email: record.createdByEmail,
    created_at: record.createdAt.toISOString(),
  };
}

type ListedService = {
  id: string;
  identifier: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  tariffs: Tariff[];
  assignments: Array<{
    id: string;
    serviceId: string;
    tariffId: string;
    orgId: string;
    teamId: string | null;
    scope: string;
    createdByEmail: string | null;
    createdAt: Date;
    updatedAt: Date;
    tariff: Tariff;
    org: { id: string; name: string };
    team: { id: string; name: string } | null;
  }>;
  appKeys: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    actorIssuer: string;
    actorAudience: string;
    actorKeyId: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdByEmail: string | null;
    createdAt: Date;
  }>;
};

export function serializeBillingService(service: ListedService) {
  return {
    id: service.id,
    identifier: service.identifier,
    name: service.name,
    active: service.active,
    tariffs: service.tariffs.map(serializeBillingTariff),
    assignments: service.assignments.map((assignment) => ({
      id: assignment.id,
      tariff_id: assignment.tariffId,
      scope: assignment.scope.toLowerCase(),
      organisation: assignment.org,
      team: assignment.team,
      tariff: serializeBillingTariff(assignment.tariff),
      created_by_email: assignment.createdByEmail,
      created_at: assignment.createdAt.toISOString(),
      updated_at: assignment.updatedAt.toISOString(),
    })),
    app_keys: service.appKeys.map((key) => ({
      id: key.id,
      name: key.name,
      key_prefix: key.keyPrefix,
      actor_issuer: key.actorIssuer,
      actor_audience: key.actorAudience,
      actor_key_id: key.actorKeyId,
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      expires_at: key.expiresAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
      created_by_email: key.createdByEmail,
      created_at: key.createdAt.toISOString(),
    })),
    created_at: service.createdAt.toISOString(),
    updated_at: service.updatedAt.toISOString(),
  };
}
