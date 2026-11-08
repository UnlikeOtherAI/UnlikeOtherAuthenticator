import type { EndpointSchema } from './schema.js';
const auth='CUSTOMER_LIFECYCLE app key + fresh exact-endpoint RS256 actor, live subject epoch and original assurance custody.';
const body={product:'registered product',organisation_id:'exact ACTIVE organisation',team_id:'selected admitted ACTIVE team; explicit null only in organisation financial realm',user_id:'exact actor'};
export const organisationBillingEndpoints:EndpointSchema[]=[
  {method:'POST',path:'/billing/v1/organisation/capabilities',auth,body,
    description:'Current organisation billing authority without Stripe, credits or Ledger.',
    response:{capabilities:'can_view_billing/can_manage_billing; false for ordinary admitted members',financial_scope:'manager only: organisation, mode, revision, immutable epoch'}},
  {method:'POST',path:'/billing/v1/organisation/overview',auth,body:{...body,billing_month:'optional YYYY-MM, current or earlier UTC month'},
    description:'Manager-only finances for the organisation across products and teams.',
    response:{sections:'Independent accrued_bill, credits, funding, subscription, history. Confirmed has data; pending_reconciliation/unavailable has code/message and no data.'},
    notes:'Selected team admits the actor, never filters money. Preserve original displayed context or absence; missing/stale409 requires display refresh and a new click. LIVE/TEST histories remain separate.'},
  {method:'POST',path:'/billing/v1/organisation/region',auth,body:{...body,region:'optional US | UK | EUROPE: absent reads, present chooses once'},
    description:'Nullable financial-subject organisation region read/choice; old 5.9 region schema unchanged.',response:{region:'BillingRegionViewV1; immutable audited choice'}},
  ...['/schemas/billing-organisation-v1.json','/schemas/billing-organisation-financial-v1.json',
    '/schemas/billing-organisation-v1.example.json','/schemas/billing-organisation-v1.openapi.json'].map(path=>({
      method:'GET',path,description:'Public strict organisation billing protocol 6.2 schema, example or OpenAPI.',response:{contract:'Versioned financial-only family; old 5.9 schemas unchanged'}})),
];
