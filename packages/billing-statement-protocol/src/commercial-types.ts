/** Product standing is independent of price, credit funding and feature flags. */
export const BILLING_PRODUCT_ENTITLEMENT_VERSION = '1.0.0' as const;
export const BILLING_PRODUCT_ENTITLEMENT_PATH = '/billing/v1/product-entitlement' as const;
export const BILLING_PRODUCT_BACKGROUND_PATH = '/billing/v1/product-entitlement/background' as const;
export const BILLING_STORAGE_ENSURE_PATH = '/billing/v1/storage/ensure-capacity' as const;
export const BILLING_STORAGE_OBSERVATION_PATH = '/billing/v1/storage/observations' as const;
export const BILLING_COMMERCIAL_EVENTS_PATH = '/billing/v1/commercial-events' as const;
export const BILLING_COMMERCIAL_ACK_PATH = '/billing/v1/commercial-events/acknowledge' as const;
export const BILLING_PHONE_RELEASE_PATH = '/billing/v1/commercial-events/phone-release' as const;

export type ProductCommercialStanding = 'free' | 'trial' | 'subscribed' | 'private_at_cost'
  | 'grace' | 'restricted';
export type ProductCommercialSubject = { product: string; organisation_id: string };
export type ProductEntitlementRequest = ProductCommercialSubject & { team_id: string; user_id: string };
export type ProductBackgroundRequest = ProductCommercialSubject & { team_id?: string; user_id?: string };
export type ProductEntitlementV1 = ProductCommercialSubject & {
  schema_version: 1;
  viewer: 'member' | 'manager' | 'background';
  subject: { team_id: string; user_id: string } | null;
  access: 'full' | 'limited';
  full_access: boolean;
  history_window_days: 14 | null;
  trial_ends_at: string | null;
  seats: { policy: 'automatic' | 'fixed' | 'free'; capacity: number | null;
    admitted: boolean; can_admit_members: boolean };
  storage: { capacity_bytes: string; used_bytes: string | null; observed_at: string | null;
    can_upload: boolean; expansion_setup_required: boolean };
  observed_at: string;
  valid_until: string;
};
export type ProductEntitlementManagerV1 = ProductEntitlementV1 & {
  standing: ProductCommercialStanding;
  /** Fee waiver never pays for inference, phone rental or another third-party service. */
  platform_fees_waived: boolean;
  third_party_costs_payable: true;
  dunning: { incident_id: string; category: 'seat' | 'storage'; failed_at: string;
    grace_ends_at: string; billing_timezone: string } | null;
};
export type StorageEnsureRequestV1 = ProductCommercialSubject & {
  operation_id: string; minimum_capacity_bytes: string;
};
export type StorageEnsureV1 = ProductCommercialSubject & {
  schema_version: 1; operation_id: string;
  state: 'admitted' | 'setup_required' | 'payment_pending' | 'restricted' | 'reconciliation_required';
  capacity_bytes: string; required_blocks: number; grace_ends_at: string | null;
};
export type StorageObservationRequestV1 = ProductCommercialSubject & {
  observation_id: string; revision: string; observed_at: string;
  measurement_version: string;
  blob_bytes: string; database_bytes: string;
};
export type CommercialEventV1 = ProductCommercialSubject & {
  event_id: string; incident_id: string;
  category: 'seat' | 'storage' | 'phone' | 'addon';
  stage: 'initial' | 'reminder' | 'final_warning' | 'restricted' | 'resolved' | 'release_due';
  failed_at: string; grace_ends_at: string; occurred_at: string;
  recipient_user_ids: string[];
  channels: Array<'alert' | 'personal_assistant' | 'email'>;
  resource_id: string | null;
};
export type CommercialEventsV1 = { schema_version: 1; events: CommercialEventV1[] };
export type CommercialAcknowledgementV1 = ProductCommercialSubject & {
  event_id: string; recipient_user_id: string; channel: 'alert' | 'personal_assistant';
  /** The successful transport's durable acceptance identifier; queued work is insufficient. */
  receipt_id: string;
};
export type PhoneReleaseRequestV1 = ProductCommercialSubject & { incident_id: string };
export type PhoneReleaseVerdictV1 = ProductCommercialSubject & {
  schema_version: 1; incident_id: string; authorized: boolean; resource_id: string;
  account_sid: string | null; phone_number_sid: string | null; valid_until: string;
};
export type StorageSetupActionV1 = { method: 'POST'; path: '/billing/v1/storage/mandate'; body: ProductEntitlementRequest & {
  catalog_id: string; consent_version: 'company-storage-auto-expansion-v1'; accepted: true;
} };
export type StorageRecoveryActionV1 = { method: 'POST'; path: '/billing/v1/storage/recover'; body: ProductEntitlementRequest & { expansion_id: string } };
export type StorageSetupV1 = { unit_amount_minor: string; currency: string; block_bytes: '1000000000000';
  cadence: 'month'; current_cycle_proration_minor: string; consent_text: string;
  consent_version: 'company-storage-auto-expansion-v1'; action: StorageSetupActionV1 };
export type StorageManagerV1 = ProductCommercialSubject & { schema_version: 1; can_manage: true;
  subject: { team_id: string; user_id: string };
  state: 'billing_region_required' | 'catalog_required' | 'cost_evidence_required' | 'setup_available'
    | 'ready' | 'payment_pending' | 'recovery_required';
  setup: StorageSetupV1 | null;
  mandate: { id: string; state: string } | null;
  subscription: { purchased_blocks: number; pending_blocks: number; currency: string; unit_amount_minor: string;
    current_period_start: string | null; current_period_end: string | null } | null;
  pending_expansion: { id: string; state: string; required_blocks: number; invoice_id: string | null;
    invoice_url: string | null; invoice_amount_minor: string | null; invoice_currency: string | null; grace_ends_at: string | null;
    recovery_action: StorageRecoveryActionV1 | null } | null;
  payment_recoveries: Array<{ incident_id: string; invoice_id: string; invoice_url: string | null;
    invoice_amount_minor: string; invoice_currency: string; grace_ends_at: string }>;
  observed_at: string; valid_until: string;
};
export type StorageReadV1 = StorageManagerV1 | (ProductCommercialSubject & {
  schema_version: 1; subject: { team_id: string; user_id: string }; can_manage: false; setup: null;
});
export type StorageMandateResultV1 = ProductCommercialSubject & { schema_version: 1; mandate_id: string } & (
  { state: 'open'; url: string; expires_at: string } |
  { state: 'accepted' | 'processing' | 'expired' | 'revoked'; url: null; expires_at: null }
);
export type StorageRecoveryResultV1 = ProductCommercialSubject & { schema_version: 1; expansion_id: string;
  attempt_id: string | null; state: 'payment_pending' | 'paid' | 'reconciliation_required' };

export const BILLING_SEATS_READ_PATH = '/billing/v1/seats' as const;
export const BILLING_SEATS_CHECKOUT_PATH = '/billing/v1/seats/checkout' as const;
export type SeatCheckoutRequestV1 = ProductEntitlementRequest & {
  offer_id: string; terms_version: 'company-standard-seat-v1'; accepted: true;
};
export type SeatPlansManagerV1 = ProductCommercialSubject & { schema_version: 1; can_manage: true;
  subject: { team_id: string; user_id: string };
  state: 'billing_region_required' | 'catalog_required' | 'available' | 'agreement_exists';
  current_human_count: number;
  agreements: Array<{ id: string; policy: 'automatic' | 'fixed'; capacity: number | null;
    unit_amount_minor: string; currency: string; effective_at: string; ends_at: string | null }>;
  usage: { currency: string; payment_mode: 'prepaid' | 'pay_as_you_go';
    terms_collectible: boolean; effective_at: string | null; pending_effective_at: string | null };
  offers: Array<{ id: string; name: 'Standard'; unit_amount_minor: string; currency: string;
    cadence: 'month'; charge_basis: 'per_human'; policy: 'automatic'; timing: 'prorated';
    usage_currency: 'USD'; usage_payment_mode: 'prepaid'; usage_markup_bps: 3000;
    terms_version: 'company-standard-seat-v1'; consent_text: string;
    action: { method: 'POST'; path: typeof BILLING_SEATS_CHECKOUT_PATH; body: SeatCheckoutRequestV1 } }>;
  observed_at: string; valid_until: string;
};
export type SeatPlansReadV1 = SeatPlansManagerV1 | (ProductCommercialSubject & {
  schema_version: 1; can_manage: false; subject: { team_id: string; user_id: string };
});
export type SeatCheckoutResultV1 = ProductCommercialSubject & { schema_version: 1;
  checkout_id: string; state: 'open'; url: string; expires_at: string };
