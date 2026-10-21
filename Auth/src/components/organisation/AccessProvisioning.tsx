import {useState} from 'react';
import {useAccessTranslation} from '../../hooks/use-access-translation.js';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {request} from '../../utils/api.js';
import {record,text} from '../../utils/enterprise-response.js';
import {accessMutation,type AccessSettings,type Connection} from '../../utils/organisation-access.js';
import {Button} from '../ui/Button.js';
import {fieldInputClassName} from '../ui/Input.js';
import {CopyValue} from './CopyValue.js';
type Data={enabled:boolean;revision:number;base:string;tokens:Array<{id:string;expires:string;revoked:boolean}>;
  resources:Array<{id:string;label:string;version:number}>;identities:Array<{id:string;subject:string}>;
  resourceCursor:string|null;identityCursor:string|null};
const nullable=(v:unknown)=>v===null?null:text(v);
const list=(v:unknown):unknown[]=>{if(!Array.isArray(v))throw new Error('Invalid list');return v;};
const integer=(v:unknown)=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1)throw new Error('Invalid revision');return v;};
function decode(value:unknown):Data {
  const r=record(value);if(r.ok!==true||typeof r.enabled!=='boolean')throw new Error('Invalid provisioning response');
  return {enabled:r.enabled,revision:integer(r.revision),base:text(r.base_url),
    tokens:list(r.tokens).map(v=>{const a=record(v);const expires=text(a.expires_at);
      if(!Number.isFinite(Date.parse(expires)))throw new Error('Invalid expiry');
      const revoked=nullable(a.revoked_at);
      if(revoked!==null&&!Number.isFinite(Date.parse(revoked)))throw new Error('Invalid revocation date');
      return {id:text(a.id),expires,revoked:revoked!==null};}),
    resources:list(r.pending_resources).map(v=>{const a=record(v);return {id:text(a.id),
      label:nullable(a.display_name)||nullable(a.user_name)||nullable(a.external_id)||text(a.id),version:integer(a.version)};}),
    identities:list(r.linked_identities).map(v=>{const a=record(v);return {id:text(a.id),subject:text(a.subject)};}),
    resourceCursor:nullable(r.next_resource_cursor),identityCursor:nullable(r.next_identity_cursor)};
}
export function AccessProvisioning({settings,connection}:{settings:AccessSettings;connection:Connection}) {
  const t=useEnterpriseTranslation();const common=useAccessTranslation();const [data,setData]=useState<Data|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  const [token,setToken]=useState<string|null>(null);const [selected,setSelected]=useState<Record<string,string>>({});
  const path='/connections/'+encodeURIComponent(connection.id)+'/scim';
  async function load(kind?:'resource'|'identity') {
    setBusy(true);setError(false);
    try {const cursor=kind==='resource'?data?.resourceCursor:data?.identityCursor;
      const result=await request<unknown>('GET','/auth/organisation-access/sso'+path+(kind&&cursor?'?'+kind+'_cursor='+encodeURIComponent(cursor):''));
      if(!result.ok)throw new Error('Provisioning unavailable');const next=decode(result.data);
      setData(previous=>kind&&previous?{...next,resources:kind==='resource'?[...new Map([...previous.resources,...next.resources].map(item=>[item.id,item])).values()]:previous.resources,
        identities:kind==='identity'?[...new Map([...previous.identities,...next.identities].map(item=>[item.id,item])).values()]:previous.identities,
        resourceCursor:kind==='resource'?next.resourceCursor:previous.resourceCursor,
        identityCursor:kind==='identity'?next.identityCursor:previous.identityCursor}:next);
    }catch{setError(true);}finally{setBusy(false);}
  }
  async function mutate(suffix:string,body:unknown={},method:'POST'|'DELETE'='POST') {
    setBusy(true);setError(false);
    try{const result=await accessMutation(settings,method,path+suffix,body);
      if(suffix==='/tokens'&&method==='POST')setToken(text(result.token));
      if(suffix==='/state')setToken(null);
      await load();return true;
    }catch{setError(true);return false;}finally{setBusy(false);}
  }
  return <details className="space-y-4 border-t border-[var(--uoa-color-border)] pt-5" onToggle={event=>{
    if(event.currentTarget.open&&!data&&!busy&&settings.scim.enabled)void load();
  }}><summary className="min-h-11 cursor-pointer font-semibold">{common('provisioning')}</summary>
    <p>{common('scimIntro')}</p>
    {!settings.scim.enabled?<p>{common('scimUnavailable')}</p>:<>
      {error&&<p role="alert">{t('error')}</p>}
      {!data?<Button disabled={busy} onClick={()=>void load()}>{t(busy?'loading':'retry')}</Button>:<>
        <CopyValue label={common('baseUrl')} value={data.base}/>
        <Button variant="secondary" disabled={busy} onClick={()=>void mutate('/state',{revision:data.revision,enabled:!data.enabled})}>
          {t(data.enabled?'provisioningOff':'provisioningOn')}</Button>
        {token&&<div className="space-y-3"><p>{common('tokenOnce')}</p><CopyValue label={common('token')} value={token}/>
          <Button variant="secondary" onClick={()=>setToken(null)}>{common('dismissToken')}</Button></div>}
        <Button disabled={busy||!data.enabled} onClick={()=>void mutate('/tokens')}>{common('issueToken')}</Button>
        {data.tokens.map(item=><div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--uoa-color-border)] py-3">
          <span>{t('tokenExpires')}: {new Date(item.expires).toLocaleString()}</span>
          {!item.revoked&&<Button className="w-auto!" variant="secondary" disabled={busy}
            onClick={()=>void mutate('/tokens/'+encodeURIComponent(item.id),{},'DELETE')}>{common('revokeToken')}</Button>}
        </div>)}
        <h3 className="font-semibold">{t('pendingPeople')}</h3><p className="text-sm">{t('reconcileHint')}</p>
        {data.resources.length===0&&<p>{t('noPending')}</p>}
        {data.identities.length===0&&data.resources.length>0&&<p>{t('noIdentities')}</p>}
        {data.resources.map(person=><div key={person.id} className="space-y-3 border-t border-[var(--uoa-color-border)] pt-3">
          <p className="break-words font-medium">{person.label}</p><label className="block text-sm">{t('linkedIdentity')}
            <select aria-label={t('linkedIdentity')} className={fieldInputClassName()} disabled={busy||!data.enabled} value={selected[person.id]??''}
              onChange={event=>setSelected(previous=>({...previous,[person.id]:event.target.value}))}>
              <option value="">—</option>{data.identities.map(identity=><option key={identity.id} value={identity.id}>{identity.subject}</option>)}
            </select></label><Button disabled={busy||!data.enabled||!selected[person.id]} onClick={()=>void mutate('/reconcile',{
              resource_id:person.id,external_identity_id:selected[person.id],version:person.version})}>{t('reconcile')}</Button>
        </div>)}
        {data.resourceCursor&&<Button variant="secondary" disabled={busy} onClick={()=>void load('resource')}>{t('more')}</Button>}
        {data.identityCursor&&<Button variant="secondary" disabled={busy} onClick={()=>void load('identity')}>{t('more')}</Button>}
      </>}
    </>}
  </details>;
}
