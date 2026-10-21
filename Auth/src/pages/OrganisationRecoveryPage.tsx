import {useAccessTranslation} from '../hooks/use-access-translation.js';
import {useEffect,useState} from 'react';
import {EnterpriseActionLayout} from '../components/layout/EnterpriseActionLayout.js';
import {Button} from '../components/ui/Button.js';
import {TwoFactorInput} from '../components/form/TwoFactorInput.js';
import {useEnterpriseTranslation} from '../i18n/enterprise-actions.js';
import {text} from '../utils/enterprise-response.js';
import {recoveryRequest} from '../utils/enterprise-recovery.js';
type Purpose='confirm'|'drill'|'recover';
const ROOT='/auth/organisation-recovery';
// StrictMode replays must not lose the address hint when removing the fragment.
let contactHint:string|undefined;
function readContact() {
  if(contactHint!==undefined)return contactHint;
  contactHint=new URLSearchParams(window.location.hash.slice(1)).get('contact')??'';
  window.history.replaceState(null,'',window.location.pathname);
  return contactHint;
}
export function OrganisationRecoveryPage() {
  const t=useEnterpriseTranslation();const accessT=useAccessTranslation();const [contact,setContact]=useState<string|null>(null);
  useEffect(()=>{setContact(readContact());},[]);
  const [challenge,setChallenge]=useState<string|null>(null);const [purpose,setPurpose]=useState<Purpose>('confirm');
  const [org,setOrg]=useState('');const [domain,setDomain]=useState('');const [confirmed,setConfirmed]=useState(false);
  const [code,setCode]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  const [done,setDone]=useState<Purpose|null>(null);
  async function start(next:Purpose) {
    setBusy(true);setError(false);setCode('');setDone(null);
    try {const r=await recoveryRequest(ROOT+'/challenge',{contact,purpose:next});
      if(r.ok!==true||r.purpose!==next||typeof r.confirmed!=='boolean'||!(/^[A-Za-z0-9_-]{43}$/).test(text(r.challenge)))throw new Error('Invalid challenge');
      setChallenge(next==='confirm'&&r.confirmed?null:text(r.challenge));setOrg(text(r.organisation_name));setDomain(text(r.client_domain));setConfirmed(r.confirmed);setPurpose(next);
    }catch{setError(true);}finally{setBusy(false);}
  }
  async function complete() {
    setBusy(true);setError(false);
    try {const r=await recoveryRequest(ROOT+'/complete',{challenge,code});
      if(r.ok!==true||r.action!==purpose)throw new Error('Invalid completion');
      setDone(purpose);setChallenge(null);setCode('');if(purpose==='confirm')setConfirmed(true);
    }catch{setError(true);}finally{setBusy(false);}
  }
  return <EnterpriseActionLayout title={t('recoveryPublic')}>
    {contact===null?<p role="status">{t('loading')}</p>:!/^[A-Za-z0-9_-]{43}$/.test(contact)?<p role="alert">{t('linkMissing')}</p>:<>
      {org&&<p className="break-words text-sm font-medium">{accessT('destination',{org,domain})}</p>}
      {error&&<p role="alert" className="text-[var(--uoa-color-danger)]">{t('error')}</p>}
      {done&&<p role="status">{t(done==='confirm'?'doneConfirm':done==='drill'?'doneDrill':'doneRecover')}</p>}
      {challenge?<form className="space-y-4" onSubmit={event=>{event.preventDefault();void complete();}}>
        <p>{t('authenticator')}</p><p className="text-sm text-[var(--uoa-color-muted)]">{t('freshCode')}</p><TwoFactorInput value={code} onChange={setCode} digits={6} label={t('code')} disabled={busy}/>
        <Button type="submit" disabled={busy||code.length!==6}>{t('submit')}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={()=>{setChallenge(null);setCode('');setError(false);}}>{t('startAgain')}</Button>
      </form>:<div className="space-y-3">
        {!confirmed&&<Button disabled={busy} onClick={()=>void start('confirm')}>{t('confirm')}</Button>}
        {confirmed&&<Button variant="secondary" disabled={busy} onClick={()=>void start('drill')}>{t(done==='drill'?'drillAgain':'drill')}</Button>}
        {confirmed&&<details><summary className="cursor-pointer py-3 font-medium">{t('recover')}</summary><div className="space-y-4">
          <p>{t('warning')}</p><Button disabled={busy} onClick={()=>void start('recover')}>{t('recover')}</Button>
        </div></details>}
      </div>}
    </>}
  </EnterpriseActionLayout>;
}
