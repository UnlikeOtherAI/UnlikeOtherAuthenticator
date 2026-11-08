import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe,expect,it } from 'vitest';
import { billingOrganisationFinancialV1Schemas as schemas } from '../src/organisation-financial-schema.js';
import { billingConsumerActionV1ConformanceFixtures as actions } from '../src/action-conformance-fixtures.js';
import { billingCyclesListV2ConformanceFixture as cycles,billingCycleDetailV2ConformanceFixture as cycle }
  from '../src/cycle-conformance-fixture.js';
import { billingCustomerInvoicesListV1ConformanceFixture as invoices,billingCustomerInvoiceDetailV1ConformanceFixture as invoice }
  from '../src/invoice-fixture.js';
import { billingSubjectRequestJsonSchema } from '../src/funding-schema-primitives.js';

const ajv=new Ajv2020({strict:true,allErrors:true});addFormats(ajv);
const validators=Object.fromEntries(Object.entries(schemas).map(([key,value])=>[key,ajv.compile(value)]));
const subject={product:'nessie',organisation_id:'org',team_id:null,user_id:'admin'};
function accepted(key:keyof typeof schemas,value:unknown){
  const validate=validators[key]!;expect(validate(value),`${key}: ${JSON.stringify(validate.errors)}`).toBe(true);
}
describe('explicit financial lifecycle schemas',()=>{
  it('compiles the complete closed family without changing old team subject schemas',()=>{
    expect(ajv.compile(billingSubjectRequestJsonSchema)(subject)).toBe(false);
    accepted('subject',subject);
  });
  it('admits null-team funding and original opaque context, never null selectors/tokens',()=>{
    for(const key of ['top_up_request','auto_top_up_setup_request','auto_top_up_update_request',
      'auto_top_up_disable_request','auto_top_up_recover_request'] as const){
      const body={...subject,billing_context:'opaque_original_context_which_is_long_enough',
        ...(key==='top_up_request'?{offer_id:'offer'}:key.endsWith('setup_request')||key.endsWith('update_request')?{option_id:'option'}:{})};
      accepted(key,body);expect(validators[key]!({...body,billing_context:null})).toBe(false);
    }
    accepted('purchase_status_request',{...subject,purchase_id:'purchase'});
    accepted('purchase_status_response',{schema_version:1,purchase_id:'purchase',state:'processing',
      title:'Confirming',message:'Awaiting the provider.',awaiting_confirmation:true});
  });
  it('admits org-only checkout/portal and cancellation round trips',()=>{
    accepted('checkout_request',{...actions.checkout_session_request,team_id:null});
    accepted('checkout_response',actions.checkout_session_response);
    accepted('portal_request',{...actions.portal_session_request,team_id:null});
    accepted('portal_response',actions.portal_session_response);
    accepted('cancellation_preview_request',{...subject,billing_context:'original_context'});
    accepted('cancellation_preview_response',actions.cancellation_preview);
    accepted('cancellation_confirm_request',{...subject,preview_token:'p'.repeat(40),idempotency_key:'i'.repeat(40),selection:null});
    accepted('cancellation_confirmation_response',actions.cancellation_confirmation);
  });
  it('admits nullable financial history bodies and responses with opaque pagination',()=>{
    accepted('cycles_list_request',{...subject,financial_scope:'organisation',billing_mode:'sandbox',cursor:'opaque.next.cursor'});
    accepted('invoices_list_request',{...subject,financial_scope:'organisation',billing_mode:'live',charge_month:'2026-11'});
    accepted('cycles_list_response',{...cycles,subject:{...cycles.subject,team_id:null},next_cursor:'opaque.next.cursor'});
    accepted('invoices_list_response',{...invoices,subject:{...invoices.subject,team_id:null}});
    accepted('cycle_detail_response',cycle);accepted('invoice_detail_response',invoice);
    const broken=structuredClone(cycle);broken.scope.team_id=null;broken.scope.cycle_scope='team';
    expect(validators.cycle_detail_response!(broken)).toBe(false);
  });
  it('admits initial region reads and immutable choices, refusing invented region fields',()=>{
    accepted('region_request',subject);accepted('region_request',{...subject,region:'EUROPE'});
    expect(validators.region_request!({...subject,region:'AUSTRALIA'})).toBe(false);
    accepted('region_response',{region:null,currency:null,suggested_region:'US',suggested_currency:'USD',suggested_from:null,can_set:true});
  });
});
