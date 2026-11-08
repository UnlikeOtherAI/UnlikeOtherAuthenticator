import type { BillingOrganisationRequestV1, BillingOrganisationFinancialDto as Financial } from './organisation-overview-types.js';
import type { BillingModeBoundAction } from './billing-mode-types.js';
import type { BillingCheckoutSessionRequest,BillingCheckoutSessionResponse,BillingPortalSessionRequest,
  BillingPortalSessionResponse,BillingHostedRedirectResponse,BillingCancellationPreviewV1,
  BillingCancellationConfirmRequest,BillingCancellationConfirmationV1,BillingErrorEnvelope,BillingCheckoutTariff } from './action-types.js';
import type { BillingCreditPurchaseStatusV1 } from './presentation-types.js';
import type { BillingRegionV1,BillingRegionViewV1 } from './org-billing-types.js';
import type { BillingCyclesListRequestV2,BillingCyclesListV2,BillingCycleDetailRequestV2,
  BillingCycleDetailV2,BillingCycleDownloadRequestV2 } from './cycle-types.js';
import type { BillingCustomerInvoicesListRequestV1,BillingCustomerInvoicesListV1,
  BillingCustomerInvoiceDetailRequestV1,BillingCustomerInvoiceDetailV1,
  BillingCustomerInvoiceDownloadRequestV1 } from './invoice-types.js';
import type { BillingRecurringAddonsV1,BillingRecurringAddonCancellationPreviewV1,
  BillingRecurringAddonCancellationConfirmRequestV1,BillingRecurringAddonCancellationConfirmationV1 } from './recurring-addon-types.js';

export const BILLING_ORGANISATION_REGION_PATH='/billing/v1/organisation/region' as const;
export type BillingOrganisationHistorySubjectV1=BillingOrganisationRequestV1 & {
  financial_scope:'organisation';billing_mode?:'live'|'sandbox';
};
export type BillingOrganisationHistoryDto<T>=T extends Array<infer V>?BillingOrganisationHistoryDto<V>[]
  :T extends object?{[K in keyof T]:K extends 'team_id'?T[K]|null:BillingOrganisationHistoryDto<T[K]>}
    &(T extends {product:string;organisation_id:string;team_id:string;user_id:string}
      ?{financial_scope?:'organisation';billing_mode?:'live'|'sandbox'}:unknown):T;
type Action=BillingOrganisationRequestV1 & BillingModeBoundAction;
/** Keys exactly match billingOrganisationFinancialV1Schemas. Empty 204 mutations have no DTO. */
export type BillingOrganisationFinancialTypes={
  subject:BillingOrganisationRequestV1;
  region_request:BillingOrganisationRequestV1 & {region?:BillingRegionV1};region_response:BillingRegionViewV1;
  top_up_request:Action & {offer_id:string};auto_top_up_setup_request:Action & {option_id:string};
  auto_top_up_update_request:Action & {option_id:string};auto_top_up_disable_request:Action;auto_top_up_recover_request:Action;
  purchase_status_request:BillingOrganisationRequestV1 & {purchase_id:string};
  hosted_redirect_response:BillingHostedRedirectResponse;purchase_status_response:Financial<BillingCreditPurchaseStatusV1>;
  checkout_request:Financial<BillingCheckoutSessionRequest>;checkout_response:BillingCheckoutSessionResponse;
  portal_request:Financial<BillingPortalSessionRequest>;portal_response:BillingPortalSessionResponse;
  subscription_summary_request:BillingOrganisationRequestV1;
  subscription_summary_response:{product:{id:string;identifier:string};subject:Omit<BillingOrganisationRequestV1,'product'>;
    tariff:BillingCheckoutTariff;assignment:{scope:'team'|'organisation'|'service_default';id:string|null};
    stripe_collection_enabled:boolean;stripe_mode:'live'|'test'|null;can_manage:boolean;
    subscription:null|{id:string;status:string;scope:'team'|'organisation';scope_key:string;tariff_id:string;
      cancel_at_period_end:boolean;current_period_start:string|null;current_period_end:string|null;
      billing_phase:'calendar_month'|'free_alignment_period'|'unknown';created_at:string;synced_at:string}};
  cancellation_preview_request:Action;cancellation_preview_response:Financial<BillingCancellationPreviewV1>;
  cancellation_confirm_request:BillingOrganisationRequestV1 & BillingCancellationConfirmRequest;
  cancellation_confirmation_response:Financial<BillingCancellationConfirmationV1>;
  addons_response:Financial<BillingRecurringAddonsV1>;addons_checkout_request:Action & {offer_id:string};
  addon_cancellation_preview_request:Action & {subscription_id:string};
  addon_cancellation_preview_response:Financial<BillingRecurringAddonCancellationPreviewV1>;
  addon_cancellation_confirm_request:Financial<BillingRecurringAddonCancellationConfirmRequestV1>;
  addon_cancellation_confirmation_response:Financial<BillingRecurringAddonCancellationConfirmationV1>;
  cycles_list_request:Financial<BillingCyclesListRequestV2> & BillingOrganisationHistorySubjectV1;
  cycles_list_response:BillingOrganisationHistoryDto<BillingCyclesListV2>;
  cycle_detail_request:Financial<BillingCycleDetailRequestV2> & BillingOrganisationHistorySubjectV1;
  cycle_detail_response:BillingOrganisationHistoryDto<BillingCycleDetailV2>;
  cycle_download_request:Financial<BillingCycleDownloadRequestV2> & BillingOrganisationHistorySubjectV1;
  invoices_list_request:Financial<BillingCustomerInvoicesListRequestV1> & BillingOrganisationHistorySubjectV1;
  invoices_list_response:BillingOrganisationHistoryDto<BillingCustomerInvoicesListV1>;
  invoice_detail_request:Financial<BillingCustomerInvoiceDetailRequestV1> & BillingOrganisationHistorySubjectV1;
  invoice_detail_response:BillingOrganisationHistoryDto<BillingCustomerInvoiceDetailV1>;
  invoice_download_request:Financial<BillingCustomerInvoiceDownloadRequestV1> & BillingOrganisationHistorySubjectV1;
  error_response:BillingErrorEnvelope;
};
