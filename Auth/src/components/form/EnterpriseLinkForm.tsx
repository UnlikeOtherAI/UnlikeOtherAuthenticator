import {useEffect,useState} from 'react';
import {useAccessTranslation} from '../../hooks/use-access-translation.js';
import {usePopup} from '../../hooks/use-popup.js';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {useTranslation} from '../../i18n/use-translation.js';
import {isEmailPasswordEnabled} from '../../utils/auth-config.js';
import {postJson} from '../../utils/api.js';
import {record,text} from '../../utils/enterprise-response.js';
import {Button} from '../ui/Button.js';
import {Input} from '../ui/Input.js';
import {PasswordInput} from '../ui/PasswordInput.js';
import {TwoFactorInput} from './TwoFactorInput.js';
export function EnterpriseLinkForm({intent}:{intent:string}) {
  const t=useEnterpriseTranslation();const accessT=useAccessTranslation();const {t:common}=useTranslation();
  const {config,configUrl,redirectUrl,codeChallenge,codeChallengeMethod,state,redirectTo}=usePopup();
  const passwordEnabled=isEmailPasswordEnabled(config);
  const [method,setMethod]=useState<'password'|'factor'>(()=>passwordEnabled?'password':'factor');
  const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [code,setCode]=useState('');
  const [challenge,setChallenge]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  const [error,setError]=useState(false);
  const [destination,setDestination]=useState<{org:string;domain:string}|null>(null);
  const [contextError,setContextError]=useState(false);const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;setDestination(null);setContextError(false);
    void postJson<unknown,unknown>('/auth/enterprise-link/context',{link_intent_id:intent},{config_url:configUrl}).then(result=>{
      if(!result.ok)throw new Error('Link context unavailable');const value=record(result.data);const org=record(value.org);
      if(value.ok!==true||!text(org.id))throw new Error('Invalid link context');
      const next={org:text(org.name),domain:text(value.client_domain)};if(active)setDestination(next);
    }).catch(()=>{if(active)setContextError(true);});
    return ()=>{active=false;};
  },[configUrl,intent,attempt]);
  const query={config_url:configUrl,redirect_url:redirectUrl,code_challenge:codeChallenge,
    code_challenge_method:codeChallengeMethod,state,enterprise_link_intent:intent};
  async function call(path:string,body:unknown) {
    const result=await postJson<unknown,unknown>(path,body,query);
    if(!result.ok)throw new Error('Link proof failed');return record(result.data);
  }
  function finish(result:Record<string,unknown>) {
    if(result.ok!==true)throw new Error('Invalid link response');
    if(typeof result.redirect_to==='string') {setPassword('');setCode('');redirectTo(result.redirect_to);return;}
    if(result.personal_factor_required===true&&/^[A-Za-z0-9_-]{43}$/.test(text(result.challenge))) {
      setChallenge(text(result.challenge));setPassword('');return;
    }
    throw new Error('Invalid link response');
  }
  async function submit() {
    setBusy(true);setError(false);
    try {
      if(challenge) finish(await call('/auth/enterprise-link/personal-factor/verify',{
        link_intent_id:intent,challenge,code}));
      else if(method==='factor') finish(await call('/auth/enterprise-link/personal-factor',{
        link_intent_id:intent,email}));
      else {
        const login=await call('/auth/login',{email,password,remember_me:false});
        const loginToken=text(login.login_token);
        finish(await call('/auth/enterprise-link/start',{link_intent_id:intent,login_token:loginToken}));
      }
    }catch{setError(true);}finally{setBusy(false);}
  }
  return <section className="space-y-4"><h1 className="text-2xl font-semibold">{t('linkTitle')}</h1><p>{t('linkIntro')}</p>
    {destination&&<p className="break-words text-sm font-medium">{accessT('destination',{org:destination.org,domain:destination.domain})}</p>}
    {contextError&&<div role="alert"><p>{t('linkUnavailable')}</p><Button variant="secondary" onClick={()=>setAttempt(previous=>previous+1)}>{t('retry')}</Button></div>}
    {!destination&&!contextError&&<p role="status">{t('loading')}</p>}
    {error&&<p role="alert" className="text-[var(--uoa-color-danger)]">{t('error')}</p>}
    {destination&&<form className="space-y-4" onSubmit={event=>{event.preventDefault();void submit();}}>
      {challenge?<><p className="break-words text-sm">{t('enteredEmail')}: {email}</p><p>{t('linkAuthenticator')}</p><p className="text-sm text-[var(--uoa-color-muted)]">{t('freshCode')}</p><TwoFactorInput value={code} onChange={setCode} digits={6}
        disabled={busy} label={t('code')}/></>:<>
        <Input type="email" autoComplete="username" required label={t('email')} value={email}
          disabled={busy} onChange={event=>setEmail(event.target.value)}/>
        {method==='password'&&<PasswordInput required autoComplete="current-password" label={t('passwordLabel')}
          value={password} disabled={busy} onChange={event=>setPassword(event.target.value)}
          showToggleLabel={common('form.password.show')} hideToggleLabel={common('form.password.hide')}/>}
      </>}
      <Button type="submit" disabled={busy||(challenge!==null&&code.length!==6)}>{t(challenge?'submit':'continue')}</Button>
      {challenge&&<Button type="button" variant="secondary" disabled={busy} onClick={()=>{setChallenge(null);setCode('');setError(false);}}>{t('startAgain')}</Button>}
    </form>}
    {destination&&!challenge&&passwordEnabled&&<Button variant="secondary" disabled={busy} onClick={()=>{setMethod(method==='password'?'factor':'password');setPassword('');setError(false);}}>
      {t(method==='password'?'factor':'password')}</Button>}
  </section>;
}
