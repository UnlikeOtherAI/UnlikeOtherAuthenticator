// @vitest-environment jsdom
import {describe,it,expect} from 'vitest';
import {decodeRecovery,recoveryLink} from './enterprise-recovery.js';
describe('recovery public boundary',()=>{
  it('rejects a foreign recovery address and an address with extra routing data',()=>{
    expect(()=>recoveryLink('https://foreign.example/auth/organisation-recovery#contact='+ 'a'.repeat(43))).toThrow();
    expect(()=>recoveryLink(window.location.origin+'/auth/organisation-recovery?redirect=elsewhere#contact='+ 'a'.repeat(43))).toThrow();
    expect(recoveryLink(window.location.origin+'/auth/organisation-recovery#contact='+ 'a'.repeat(43))).toContain('#contact=');
  });
  it('validates owner candidates and confirmation states before presenting them',()=>{
    const value={revision:1,setup_complete:false,drill_complete:false,next_cursor:null,
      candidates:[{user_id:'person',display_name:null,email:'person@example.test',eligible:false}],
      contacts:[{user_id:'person',status:'pending',confirmed_at:null,last_drill_at:null}]};
    expect(decodeRecovery(value).candidates[0]?.eligible).toBe(false);
    expect(()=>decodeRecovery({...value,contacts:[{...value.contacts[0],status:'owner'}]})).toThrow();
    expect(()=>decodeRecovery({...value,candidates:[{...value.candidates[0],eligible:'true'}]})).toThrow();
  });
});
