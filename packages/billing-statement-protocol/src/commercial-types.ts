/** Product standing is independent of price, credit funding and feature flags. */
export const BILLING_PRODUCT_ENTITLEMENT_VERSION = '1.0.0' as const;
export const BILLING_PRODUCT_ENTITLEMENT_PATH = '/billing/v1/product-entitlement' as const;
export const BILLING_PRODUCT_BACKGROUND_PATH = '/billing/v1/product-entitlement/background' as const;
export const BILLING_STORAGE_ENSURE_PATH = '/billing/v1/storage/ensure-capacity' as const;
export const BILLING_STORAGE_OBSERVATION_PATH = '/billing/v1/storage/observations' as const;
export const BILLING_COMMERCIAL_EVENTS_PATH = '/billing/v1/commercial-events' as const;
export const BILLING_COMMERCIAL_ACK_PATH = '/billing/v1/commercial-events/acknowledge' as const;

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
