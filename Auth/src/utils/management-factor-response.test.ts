import {describe,expect,it} from 'vitest';
import {decodeManagementFactorChallenge,decodeManagementFactorDestination} from './management-factor-response.js';
const now=Date.parse('2026-10-18T00:00:00.000Z');
const challenge={ok:true,personal_factor_required:true,challenge:'a'.repeat(43),
  expires_at:'2026-10-18T00:05:00.000Z',org:{id:'org',name:'Acme'},client_domain:'product.example'};
describe('personal management factor response boundary',()=>{
  it('accepts only the exact intended organisation and a live opaque challenge',()=>{
    expect(decodeManagementFactorChallenge(challenge,'org',now).org).toBe('Acme');
    expect(()=>decodeManagementFactorChallenge(challenge,'other',now)).toThrow();
    expect(()=>decodeManagementFactorChallenge(challenge,'org',now+300000)).toThrow();
    expect(()=>decodeManagementFactorChallenge({...challenge,challenge:'invalid'},'org',now)).toThrow();
  });
  it('rejects malformed consumed context and protocol fields',()=>{
    for(const value of [{...challenge,personal_factor_required:'true'},{...challenge,expires_at:'tomorrow'},
      {...challenge,org:{id:'org',name:null}},{...challenge,client_domain:null}]) {
      expect(()=>decodeManagementFactorChallenge(value,'org',now)).toThrow();
    }
  });
  it('permits only the same-origin management fragment destination',()=>{
    const origin='https://uoa.example';const path='/auth/organisation-access#continuation='+'b'.repeat(43);
    expect(decodeManagementFactorDestination({ok:true,redirect_to:origin+path},origin)).toBe(origin+path);
    for(const target of ['https://foreign.example'+path,origin+'/auth#continuation='+'b'.repeat(43),
      origin+'/auth/organisation-access?token=unexpected#continuation='+'b'.repeat(43),
      'https://name:password@uoa.example'+path,origin+'/auth/organisation-access#continuation=short']) {
      expect(()=>decodeManagementFactorDestination({ok:true,redirect_to:target},origin)).toThrow();
    }
  });
});
