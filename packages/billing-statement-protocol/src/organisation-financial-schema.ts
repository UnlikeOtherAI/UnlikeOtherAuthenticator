import { billingModeContextProperties } from './billing-mode-types.js';
import { billingSubjectRequestJsonSchema } from './funding-schema-primitives.js';
import { organisationFinancialSubjectSchema } from './organisation-financial-subject-schema.js';
import { billingCancellationConfirmationV1JsonSchema, billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema, billingCheckoutSessionRequestJsonSchema,
  billingCheckoutSessionResponseJsonSchema, billingPortalSessionRequestJsonSchema,
  billingPortalSessionResponseJsonSchema, billingHostedRedirectResponseJsonSchema,
  billingErrorEnvelopeJsonSchema } from './action-schema.js';
import { billingCheckoutTariffJsonSchema } from './action-schema.js';
import type { BillingOrganisationFinancialTypes } from './organisation-financial-types.js';
import { billingCreditPurchaseStatusV1JsonSchema } from './presentation-schema.js';
import { billingRegionViewV1JsonSchema } from './org-billing-schema.js';
import { billingCyclesListRequestV2JsonSchema,billingCyclesListV2JsonSchema,
  billingCycleDetailRequestV2JsonSchema,billingCycleDetailV2JsonSchema,billingCycleDownloadRequestV2JsonSchema } from './cycle-schema.js';
import { billingCustomerInvoicesListRequestV1JsonSchema,billingCustomerInvoicesListV1JsonSchema,
  billingCustomerInvoiceDetailRequestV1JsonSchema,billingCustomerInvoiceDetailV1JsonSchema,
  billingCustomerInvoiceDownloadRequestV1JsonSchema } from './invoice-schema.js';
import { billingRecurringAddonsV1JsonSchema,billingRecurringAddonCancellationPreviewV1JsonSchema,
  billingRecurringAddonCancellationConfirmRequestV1JsonSchema,billingRecurringAddonCancellationConfirmationV1JsonSchema } from './recurring-addon-schema.js';

export const BILLING_ORGANISATION_FINANCIAL_SCHEMA_PATH='/schemas/billing-organisation-financial-v1.json' as const;
/** Standalone financial-only copies have no old $id. Old 5.9 schemas are untouched. */
function financial(source:unknown):Record<string,unknown> {
  const result=organisationFinancialSubjectSchema(structuredClone(source)) as Record<string,unknown>;
  delete result.$schema;delete result.$id;return result;
}
const id={type:'string',minLength:1,maxLength:256};
const subject=financial(billingSubjectRequestJsonSchema);
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({
  type:'object',additionalProperties:false,properties,required,
});
const properties=subject.properties as Record<string,unknown>;
const action=(extra:Record<string,unknown>={},required=Object.keys(extra))=>object({
  ...properties,...billingModeContextProperties,...extra},[...billingSubjectRequestJsonSchema.required,...required]);
const historyFields={financial_scope:{const:'organisation'},billing_mode:{enum:['live','sandbox']}};
function history(source:unknown):Record<string,unknown> {
  const result=financial(source);
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    const node=value as Record<string,unknown>;const p=node.properties as Record<string,unknown>|undefined;
    if(p?.product&&p.organisation_id&&p.team_id&&p.user_id)node.properties={...p,...historyFields};
    if(p?.cursor)node.properties={...(node.properties as object),cursor:{type:'string',minLength:1,maxLength:2048}};
    if(p?.next_cursor)node.properties={...(node.properties as object),next_cursor:{anyOf:[{type:'string',minLength:1,maxLength:2048},{type:'null'}]}};
    Object.values(node).forEach(visit);
  };visit(result);return result;
}
const historyRequest=(source:unknown)=>{
  const result=history(source);result.required=[...(result.required as string[]),'financial_scope'];return result;
};
const datetime={type:'string',format:'date-time'};
const nullableDate={anyOf:[datetime,{type:'null'}]};
const summary=object({product:object({id,identifier:id}),subject:object({user_id:id,organisation_id:id,
  team_id:{anyOf:[id,{type:'null'}]}}),tariff:billingCheckoutTariffJsonSchema,
  assignment:object({scope:{enum:['team','organisation','service_default']},id:{anyOf:[id,{type:'null'}]}}),
  stripe_collection_enabled:{type:'boolean'},stripe_mode:{enum:['live','test',null]},can_manage:{type:'boolean'},
  subscription:{anyOf:[{type:'null'},object({id,status:id,scope:{enum:['team','organisation']},scope_key:id,tariff_id:id,
    cancel_at_period_end:{type:'boolean'},current_period_start:nullableDate,current_period_end:nullableDate,
    billing_phase:{enum:['calendar_month','free_alignment_period','unknown']},created_at:datetime,synced_at:datetime})]}});
/** All schemas are closed. Only named team_id admits null; URLs/IDs/tokens stay exact. */
export const billingOrganisationFinancialV1Schemas={
  subject,
  region_request:object({...properties,region:{enum:['UK','US','EUROPE']}},[...billingSubjectRequestJsonSchema.required]),
  region_response:financial(billingRegionViewV1JsonSchema),
  top_up_request:action({offer_id:id}),auto_top_up_setup_request:action({option_id:id}),
  auto_top_up_update_request:action({option_id:id}),auto_top_up_disable_request:action(),
  auto_top_up_recover_request:action(),purchase_status_request:object({...properties,purchase_id:id}),
  hosted_redirect_response:financial(billingHostedRedirectResponseJsonSchema),
  purchase_status_response:financial(billingCreditPurchaseStatusV1JsonSchema),
  checkout_request:financial(billingCheckoutSessionRequestJsonSchema),checkout_response:financial(billingCheckoutSessionResponseJsonSchema),
  portal_request:financial(billingPortalSessionRequestJsonSchema),portal_response:financial(billingPortalSessionResponseJsonSchema),
  subscription_summary_request:subject,subscription_summary_response:summary,
  cancellation_preview_request:action(),cancellation_preview_response:financial(billingCancellationPreviewV1JsonSchema),
  cancellation_confirm_request:object({...properties,...billingCancellationConfirmRequestJsonSchema.properties},
    [...billingSubjectRequestJsonSchema.required,...billingCancellationConfirmRequestJsonSchema.required]),
  cancellation_confirmation_response:financial(billingCancellationConfirmationV1JsonSchema),
  addons_response:financial(billingRecurringAddonsV1JsonSchema),addons_checkout_request:action({offer_id:id}),
  addon_cancellation_preview_request:action({subscription_id:id}),
  addon_cancellation_preview_response:financial(billingRecurringAddonCancellationPreviewV1JsonSchema),
  addon_cancellation_confirm_request:financial(billingRecurringAddonCancellationConfirmRequestV1JsonSchema),
  addon_cancellation_confirmation_response:financial(billingRecurringAddonCancellationConfirmationV1JsonSchema),
  cycles_list_request:historyRequest(billingCyclesListRequestV2JsonSchema),
  cycles_list_response:history(billingCyclesListV2JsonSchema),
  cycle_detail_request:historyRequest(billingCycleDetailRequestV2JsonSchema),
  cycle_detail_response:history(billingCycleDetailV2JsonSchema),
  cycle_download_request:historyRequest(billingCycleDownloadRequestV2JsonSchema),
  invoices_list_request:historyRequest(billingCustomerInvoicesListRequestV1JsonSchema),
  invoices_list_response:history(billingCustomerInvoicesListV1JsonSchema),
  invoice_detail_request:historyRequest(billingCustomerInvoiceDetailRequestV1JsonSchema),
  invoice_detail_response:history(billingCustomerInvoiceDetailV1JsonSchema),
  invoice_download_request:historyRequest(billingCustomerInvoiceDownloadRequestV1JsonSchema),
  error_response:financial(billingErrorEnvelopeJsonSchema),
} as const satisfies Record<keyof BillingOrganisationFinancialTypes,unknown>;
export const billingOrganisationFinancialV1JsonSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',$id:BILLING_ORGANISATION_FINANCIAL_SCHEMA_PATH,
  title:'UOA explicit organisation financial lifecycle',
  $defs:billingOrganisationFinancialV1Schemas,
} as const;
