import { record, text } from './enterprise-response.js';
import { request } from './api.js';
import { AccessError } from './organisation-access-schema.js';
export type Candidate={user_id:string;display_name:string|null;email:string;eligible:boolean};
export type Contact={user_id:string;status:'pending'|'confirmed'|'unavailable';confirmed_at:string|null;last_drill_at:string|null};
export type Recovery={revision:number;setup_complete:boolean;drill_complete:boolean;contacts:Contact[];candidates:Candidate[];next_cursor:string|null};
const invalid=():never=>{throw new AccessError(502);};

const nullable=(v:unknown)=>v===null?null:text(v);
const date=(v:unknown)=>{const value=nullable(v);if(value!==null&&!Number.isFinite(Date.parse(value)))return invalid();return value;};
const bool=(v:unknown)=>typeof v==='boolean'?v:invalid();
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:invalid();
export async function recoveryRequest(path:string,body?:unknown,csrfToken?:string,put=false):Promise<Record<string,unknown>> {
  const result=await request<unknown>(body===undefined?'GET':put?'PUT':'POST',path,{body,csrfToken});
  if (!result.ok) throw new AccessError(result.status);
  return record(result.data);
}
export function decodeRecovery(value:unknown):Recovery {
  const r=record(value);
  if (!Number.isSafeInteger(r.revision) || Number(r.revision)<1) return invalid();
  return {revision:Number(r.revision),setup_complete:bool(r.setup_complete),drill_complete:bool(r.drill_complete),
    next_cursor:nullable(r.next_cursor),candidates:array(r.candidates).map(v=>{const p=record(v);
      return {user_id:text(p.user_id),display_name:nullable(p.display_name),email:text(p.email),eligible:bool(p.eligible)};}),
    contacts:array(r.contacts).map(v=>{const c=record(v);
      if(c.status!=='pending'&&c.status!=='confirmed'&&c.status!=='unavailable') return invalid();
      return {user_id:text(c.user_id),status:c.status,confirmed_at:date(c.confirmed_at),last_drill_at:date(c.last_drill_at)};})};
}
export function recoveryLink(value:unknown):string {
  const url=new URL(text(value));
  if(url.origin!==window.location.origin || url.pathname!=='/auth/organisation-recovery' || url.search
    || !/^#contact=[A-Za-z0-9_-]{43}$/.test(url.hash)) return invalid();
  return url.href;
}
