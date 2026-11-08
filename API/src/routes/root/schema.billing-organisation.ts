import type { EndpointSchema } from './schema.js';
const auth='CUSTOMER_LIFECYCLE app key + fresh exact-endpoint RS256 actor, live subject epoch and original assurance custody.';
const body={product:'registered product',organisation_id:'exact ACTIVE organisation',team_id:'selected admitted ACTIVE team; explicit null only in organisation financial realm',user_id:'exact actor'};
export const organisationBillingEndpoints:EndpointSchema[]=[
  {method:'POST',path:'/billing/v1/organisation/capabilities',auth,body,
    description:'Current organisation financial authority or own-team reader admission without Stripe, credits or Ledger.',
    response:{capabilities:'Without authority header: strict schema1 booleans, true only for ACTIVE organisation owner/admin.',
      authority:'X-UOA-Billing-Authority-Protocol:1.0.0 negotiates strict schema2 access organisation_manager | team_reader | none. Only organisation_manager has financial_scope. Team reader has exact team_scope and overview_request.'}},
  {method:'POST',path:'/billing/v1/team/overview',auth,body:{...body,team_id:'exact non-null selected ACTIVE team',billing_month:'optional current or earlier YYYY-MM'},
    description:'Own-team read-only attribution for current selected-team owner/admin or organisation manager; no organisation money or actions.',
    response:{sections:'Independent recorded activity, captured-account/mode credit usage and retained TEAM credit history. Unconfirmed sections have no data. No shared wallet, invoice, subscription, card, consent or amount due.'},
    notes:'403 BILLING_TEAM_ACCESS_REQUIRED on current own-team authority refusal. source_ref is opaque provenance; canonical mode/labels are display-safe. Historical TEST records remain history; new ORG wallets start fresh.'},
  {method:'POST',path:'/billing/v1/organisation/overview',auth,body:{...body,billing_month:'optional YYYY-MM, current or earlier UTC month'},
    description:'ACTIVE organisation-owner/admin-only finances across products and teams. Team-only administrators cannot read or mutate Org money.',
    response:{sections:'Independent accrued_bill, credits, funding, subscription, history and optional attention. Confirmed has data; pending_reconciliation/unavailable has code/message and no data. Only confirmed attention [] clears the exact organisation/mode/epoch/revision.'},
    notes:'Selected team admits the actor, never filters money. Funding can confirm saved consent/disable with empty unavailable offers/options during provider or FX failure; it never quotes missing rates. Preserve original displayed context or absence; missing/stale409 requires display refresh and a new click. LIVE/TEST histories remain separate.'},
  {method:'POST',path:'/billing/v1/organisation/region',auth,body:{...body,region:'optional US | UK | EUROPE: absent reads, present chooses once'},
    description:'Nullable financial-subject organisation region read/choice; old 5.9 region schema unchanged.',response:{region:'BillingRegionViewV1; immutable audited choice'}},
  ...['/schemas/billing-organisation-v1.json','/schemas/billing-organisation-financial-v1.json',
    '/schemas/billing-organisation-v1.example.json','/schemas/billing-organisation-v1.openapi.json',
    '/schemas/billing-authority-v1.json','/schemas/billing-authority-v1.example.json',
    '/schemas/billing-authority-v1.openapi.json'].map(path=>({
      method:'GET',path,description:'Public strict billing protocol 6.4 schema, example or OpenAPI.',response:{contract:'Separate Org finance and own-team reader families; pre-6.4 schema shapes unchanged'}})),
];
