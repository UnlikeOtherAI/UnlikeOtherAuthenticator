import {useState} from 'react';
import {useAccessTranslation} from '../../hooks/use-access-translation.js';
import {usePopup} from '../../hooks/use-popup.js';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {postJson} from '../../utils/api.js';
import {decodeManagementFactorChallenge,decodeManagementFactorDestination,
  type ManagementFactorChallenge} from '../../utils/management-factor-response.js';
import {Button} from '../ui/Button.js';
import {Input} from '../ui/Input.js';
import {TwoFactorInput} from './TwoFactorInput.js';

/** Existing personal factor only: the server remains the owner and browser authority. */
export function ManagementPersonalFactorForm({orgId,onBack}:{orgId:string;onBack:()=>void}) {
  const t=useEnterpriseTranslation();const accessT=useAccessTranslation();
  const {configUrl,redirectUrl,codeChallenge,codeChallengeMethod,state,redirectTo}=usePopup();
  const [email,setEmail]=useState('');const [code,setCode]=useState('');
  const [challenge,setChallenge]=useState<ManagementFactorChallenge|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  async function submit() {
    setBusy(true);setError(false);
    try {
      if(challenge) {
        if(challenge.expiresAt<=Date.now())throw new Error('Factor expired');
        const response=await postJson<unknown,unknown>('/auth/organisation-access/personal-factor/verify',
          {challenge:challenge.value,code},{config_url:configUrl});
        if(!response.ok)throw new Error('Factor unavailable');
        const target=decodeManagementFactorDestination(response.data,window.location.origin);
        setCode('');redirectTo(target);return;
      }
      if(!codeChallenge||codeChallengeMethod!=='S256')throw new Error('Management context unavailable');
      const response=await postJson<unknown,unknown>('/auth/organisation-access/personal-factor',{
        org_id:orgId,email,code_challenge:codeChallenge,code_challenge_method:codeChallengeMethod,
        ...(redirectUrl?{redirect_url:redirectUrl}:{}),...(state?{state}:{}),
      },{config_url:configUrl});
      if(!response.ok)throw new Error('Factor unavailable');
      setChallenge(decodeManagementFactorChallenge(response.data,orgId));
    }catch{setCode('');setError(true);}finally{setBusy(false);}
  }
  return <section className="space-y-4">
    <h1 className="text-2xl font-semibold">{accessT('managementTitle')}</h1>
    <p>{accessT('managementHint')}</p>
    {challenge&&<p className="break-words text-sm font-medium">
      {accessT('destination',{org:challenge.org,domain:challenge.domain})}</p>}
    {error&&<p role="alert" className="text-[var(--uoa-color-danger)]">{t('error')}</p>}
    <form className="space-y-4" onSubmit={event=>{event.preventDefault();void submit();}}>
      {challenge?<><p className="break-words text-sm">{t('enteredEmail')}: {email}</p>
        <p>{t('linkAuthenticator')}</p><p className="text-sm text-[var(--uoa-color-muted)]">{t('freshCode')}</p>
        <TwoFactorInput value={code} onChange={setCode} digits={6} disabled={busy} label={t('code')}/>
      </>:<Input type="email" autoComplete="username" required label={t('email')} value={email}
        disabled={busy} onChange={event=>setEmail(event.target.value)}/>}
      <Button type="submit" disabled={busy||(challenge!==null&&code.length!==6)}>{t(challenge?'submit':'continue')}</Button>
      {challenge&&<Button type="button" variant="secondary" disabled={busy}
        onClick={()=>{setChallenge(null);setCode('');setError(false);}}>{t('startAgain')}</Button>}
    </form>
    <Button type="button" variant="secondary" disabled={busy} onClick={onBack}>{accessT('back')}</Button>
  </section>;
}
