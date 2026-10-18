import {useEffect,useState} from 'react';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {record,text} from '../../utils/enterprise-response.js';
import {decodeRecovery,recoveryRequest,recoveryLink,type Recovery} from '../../utils/enterprise-recovery.js';
import type {AccessSettings} from '../../utils/organisation-access.js';
import {Button} from '../ui/Button.js';
import {CopyValue} from './CopyValue.js';
const ROOT='/auth/organisation-access/sso/recovery';
export function AccessRecovery({settings}:{settings:AccessSettings}) {
  const t=useEnterpriseTranslation();
  const [data,setData]=useState<Recovery|null>(null);
  const [ids,setIds]=useState<string[]>([]);
  const [links,setLinks]=useState<Array<{id:string;url:string}>>([]);
  const [error,setError]=useState(false); const [busy,setBusy]=useState(false);
  async function load(cursor?:string) {
    setBusy(true);setError(false);
    try { const next=decodeRecovery(await recoveryRequest(ROOT+(cursor?'?cursor='+encodeURIComponent(cursor):'')));
      setData(previous=>cursor&&previous?{...next,candidates:[...previous.candidates,...next.candidates]}:next);
      if(!cursor) setIds(next.contacts.map(c=>c.user_id));
    } catch {setError(true);} finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  async function save() {
    if(!data)return;setBusy(true);setError(false);setLinks([]);
    try {
      const r=await recoveryRequest(ROOT,{revision:data.revision,custodian_user_ids:ids},settings.csrf_token,true);
      if(r.ok!==true||!Array.isArray(r.invitations))throw new Error('Invalid recovery response');
      const invitations=r.invitations.map(v=>{const item=record(v);return {id:text(item.user_id),url:recoveryLink(item.recovery_url)};});
      await load();setLinks(invitations);
    }catch{setError(true);}finally{setBusy(false);}
  }
  const locked=settings.policy.enforcement!=='off';
  const canSave=ids.length===2&&ids.every(id=>data?.candidates.some(person=>person.user_id===id&&person.eligible&&Boolean(person.display_name||person.email)));
  return <section className="space-y-4"><h2 className="text-xl font-semibold">{t('recovery')}</h2>
    <p>{t('recoveryIntro')}</p>
    {error&&<div role="alert"><p>{t('error')}</p><Button onClick={()=>void load()} disabled={busy}>{t('retry')}</Button></div>}
    {!data?<p role="status">{t('loading')}</p>:<>
      <p role="status">{t(data.drill_complete?'ready':'practiceNeeded')}</p>
      {locked&&<p>{t('locked')}</p>}
      {!data.next_cursor&&data.candidates.filter(person=>person.eligible).length<2&&<p>{t('peopleSetupHint')}</p>}
      <Button variant="secondary" disabled={busy} onClick={()=>void load()}>{t('refreshPeople')}</Button>
      {data.contacts.filter(contact=>ids.includes(contact.user_id)&&!data.candidates.some(person=>person.user_id===contact.user_id)).map(contact=>
        <div key={contact.user_id} className="space-y-2 rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] p-3">
          <p>{t('unknown')} · {t(contact.status)}</p><Button variant="secondary" disabled={busy||locked}
            onClick={()=>setIds(previous=>previous.filter(id=>id!==contact.user_id))}>{t('removeContact')}</Button>
        </div>)}
      <fieldset className="space-y-2" disabled={busy||locked}><legend className="mb-3 font-medium">{t('select')}</legend>
        {data.candidates.map(person=>{const contact=data.contacts.find(c=>c.user_id===person.user_id);
          return <label key={person.user_id} className="flex items-start gap-3 rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] p-3">
            <input type="checkbox" className="mt-1" checked={ids.includes(person.user_id)}
              disabled={(!person.eligible&&!ids.includes(person.user_id))||(!ids.includes(person.user_id)&&ids.length===2)}
              onChange={event=>setIds(previous=>event.target.checked?[...previous,person.user_id]:previous.filter(id=>id!==person.user_id))}/>
            <span className="min-w-0 break-words"><span className="block font-medium">{person.display_name||person.email||t('unknown')}</span>
              {person.display_name&&<span className="block text-sm">{person.email}</span>}
              <span className="block text-sm text-[var(--uoa-color-muted)]">{!person.eligible?t('ineligible'):contact?t(contact.status==='confirmed'?(contact.last_drill_at&&Date.parse(contact.last_drill_at)+30*86400000>Date.now()?'practised':'practicePending'):contact.status):''}</span></span>
          </label>;})}
      </fieldset>
      {data.next_cursor&&<Button variant="secondary" disabled={busy} onClick={()=>void load(data.next_cursor ?? undefined)}>{t('more')}</Button>}
      {data.contacts.length>0&&<p className="text-sm">{t('replaceWarning')}</p>}
      <Button disabled={busy||locked||!canSave} onClick={()=>void save()}>{t(data.contacts.length>0?'replaceContacts':'save')}</Button>
      {links.length>0&&<div className="space-y-4" role="status"><p>{t('links')}</p>{links.map(link=><CopyValue key={link.id}
        label={data.candidates.find(c=>c.user_id===link.id)?.display_name||data.candidates.find(c=>c.user_id===link.id)?.email||t('unknown')}
        value={link.url}/>)}</div>}
    </>}
  </section>;
}
