import type {
  createBillingInvoiceIssuerProfile,
  getOrganisationInvoiceProfile,
} from '../../../services/billing-invoice-profile.service.js';
import { exactMoney, minorAmountToMajor } from '../../../services/billing-money.service.js';

export type ContractVersionActivationState =
  | 'active'
  | 'ready'
  | 'scheduled'
  | 'superseded'
  | 'contract_terminated';

type SerializableContractVersion = {
  id: string;
  version: number;
  usageMarkupBps: number;
  currency: string;
  paymentTermsDays: number;
  effectiveFromMonth: string;
  createdAt: Date;
  serviceTerms?: Array<{
    serviceId: string;
    tariffId: string;
    monthlyAmountMinor: bigint;
    service?: { identifier: string; name: string };
  }>;
};

export function currentBillingMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function serializeContractVersion(
  version: SerializableContractVersion,
  activationState: ContractVersionActivationState,
) {
  return {
    id: version.id,
    version: version.version,
    usage_markup_bps: version.usageMarkupBps,
    usage_markup_percent: (version.usageMarkupBps / 100).toFixed(2),
    currency: version.currency,
    payment_terms_days: version.paymentTermsDays,
    effective_from_month: version.effectiveFromMonth,
    services: (version.serviceTerms ?? []).map((term) => ({
      service_id: term.serviceId,
      service_identifier: term.service?.identifier ?? null,
      service_name: term.service?.name ?? null,
      tariff_id: term.tariffId,
      monthly_amount_minor: term.monthlyAmountMinor.toString(),
      monthly_price: {
        amount_minor: term.monthlyAmountMinor.toString(),
        ...exactMoney(
          minorAmountToMajor(term.monthlyAmountMinor.toString(), version.currency),
          version.currency,
        ),
      },
    })),
    actions: {
      activation_state: activationState,
      activate: activationState === 'ready',
    },
    created_at: version.createdAt.toISOString(),
  };
}

function versionActivationState(
  version: SerializableContractVersion,
  currentActive: SerializableContractVersion | null,
  contractTerminated: boolean,
): ContractVersionActivationState {
  if ((version.serviceTerms?.length ?? 0) > 0) {
    return version.id === currentActive?.id ? 'active' : 'superseded';
  }
  if (contractTerminated) return 'contract_terminated';
  if (version.effectiveFromMonth > currentBillingMonth()) return 'scheduled';
  if (currentActive && version.effectiveFromMonth <= currentActive.effectiveFromMonth) {
    return 'superseded';
  }
  return 'ready';
}

export function serializeBillingContract(contract: {
  id: string;
  orgId: string;
  reference: string;
  name: string;
  status: string;
  activatedAt: Date | null;
  terminatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  org?: { name: string };
  versions?: SerializableContractVersion[];
}) {
  const versions = contract.versions ?? [];
  const currentActive =
    [...versions]
      .filter((version) => (version.serviceTerms?.length ?? 0) > 0)
      .sort(
        (left, right) =>
          right.effectiveFromMonth.localeCompare(left.effectiveFromMonth) ||
          right.version - left.version,
      )[0] ?? null;
  const contractTerminated = contract.status.toLowerCase() === 'terminated';
  return {
    id: contract.id,
    organisation_id: contract.orgId,
    organisation_name: contract.org?.name ?? null,
    reference: contract.reference,
    name: contract.name,
    status: contract.status.toLowerCase(),
    activated_at: contract.activatedAt?.toISOString() ?? null,
    terminated_at: contract.terminatedAt?.toISOString() ?? null,
    versions: versions.map((version) =>
      serializeContractVersion(
        version,
        versionActivationState(version, currentActive, contractTerminated),
      ),
    ),
    actions: { add_version: !contractTerminated },
    created_at: contract.createdAt.toISOString(),
    updated_at: contract.updatedAt.toISOString(),
  };
}

export function serializeInvoiceIssuer(
  profile: Awaited<ReturnType<typeof createBillingInvoiceIssuerProfile>>,
) {
  return {
    id: profile.id,
    key: profile.key,
    legal_name: profile.legalName,
    trading_name: profile.tradingName,
    billing_email: profile.billingEmail,
    address: profile.address,
    tax_identifier: profile.taxIdentifier,
    company_registration_number: profile.companyRegistrationNumber,
    invoice_number_prefix: profile.invoiceNumberPrefix,
    active: profile.active,
    created_at: profile.createdAt.toISOString(),
    updated_at: profile.updatedAt.toISOString(),
  };
}

export function serializeInvoiceBuyer(
  profile: Awaited<ReturnType<typeof getOrganisationInvoiceProfile>>,
) {
  return {
    id: profile.id,
    organisation_id: profile.orgId,
    legal_name: profile.legalName,
    billing_email: profile.billingEmail,
    billing_address: profile.billingAddress,
    tax_identifier: profile.taxIdentifier,
    purchase_order_reference: profile.purchaseOrderReference,
    created_at: profile.createdAt.toISOString(),
    updated_at: profile.updatedAt.toISOString(),
  };
}
