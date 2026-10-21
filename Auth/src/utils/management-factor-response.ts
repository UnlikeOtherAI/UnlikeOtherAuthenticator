import {record,text} from './enterprise-response.js';

export type ManagementFactorChallenge = {value:string;expiresAt:number;org:string;domain:string};
export function decodeManagementFactorChallenge(input:unknown,orgId:string,now=Date.now()):ManagementFactorChallenge {
  const value=record(input);const org=record(value.org);
  const token=text(value.challenge);const expiry=text(value.expires_at);const expiresAt=Date.parse(expiry);
  const name=text(org.name);const domain=text(value.client_domain);
  if(value.ok!==true||value.personal_factor_required!==true||text(org.id)!==orgId
    ||!/^[A-Za-z0-9_-]{43}$/.test(token)||!Number.isFinite(expiresAt)||expiresAt<=now
    ||new Date(expiresAt).toISOString()!==expiry||!name.trim()||!domain.trim()) {
    throw new Error('Invalid management challenge');
  }
  return {value:token,expiresAt,org:name,domain};
}

export function decodeManagementFactorDestination(input:unknown,origin:string):string {
  const value=record(input);const target=new URL(text(value.redirect_to),origin);
  if(value.ok!==true||target.origin!==origin||target.pathname!=='/auth/organisation-access'
    ||target.username||target.password||target.search
    ||!/^#continuation=[A-Za-z0-9_-]{43}$/.test(target.hash))throw new Error('Invalid management destination');
  return target.toString();
}
