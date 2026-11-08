import {describe,expect,it} from 'vitest';
import {organisationCardExpired} from '../../src/services/billing-organisation-attention.service.js';
describe('persisted organisation card expiry evidence',()=>{
  const now=new Date('2026-11-08T00:00:00.000Z');
  it('does not invent an expiry for a wallet with no saved method',()=>{
    expect(organisationCardExpired(null,null,now)).toBe(false);
  });
  it('keeps a card valid through the end of its UTC expiry month',()=>{
    expect(organisationCardExpired('pm_owned',{type:'card',exp_month:11,exp_year:2026},now)).toBe(false);
    expect(organisationCardExpired('pm_owned',{type:'card',exp_month:10,exp_year:2026},now)).toBe(true);
    expect(organisationCardExpired('pm_owned',{type:'card',exp_month:12,exp_year:2025},now)).toBe(true);
  });
  it.each([null,{}, {type:'bank_account'}, {type:'card',exp_month:13,exp_year:2026},
    {type:'card',exp_month:'11',exp_year:2026},{type:'card',exp_month:11,exp_year:2026.5}])(
    'holds missing or malformed provider-authored expiry instead of guessing',value=>{
      expect(()=>organisationCardExpired('pm_owned',value,now)).toThrow('BILLING_ATTENTION_PAYMENT_METHOD_UNPROVEN');
    });
});
