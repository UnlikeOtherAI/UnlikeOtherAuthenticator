import {useState} from 'react';
import {useAccessTranslation} from '../../hooks/use-access-translation.js';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import type {Connection} from '../../utils/organisation-access.js';
import {Button} from '../ui/Button.js';
import {Input,fieldInputClassName} from '../ui/Input.js';
import {CopyValue} from './CopyValue.js';
export function ConnectionMaintenance({connection:c,busy,mutate}:{connection:Connection;busy:boolean;
  mutate:(method:'POST'|'DELETE',path:string,body?:unknown)=>Promise<Record<string,unknown>|undefined>}) {
  const t=useEnterpriseTranslation();const common=useAccessTranslation();const [credential,setCredential]=useState('');
  const path='/connections/'+encodeURIComponent(c.id);const tested=c.tested_revision===c.revision;
  async function rotate() {
    const body=c.protocol==='oidc'?{secret:credential}:{certificates:credential.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)??[credential]};
    const result=await mutate('POST',path+'/credentials/rotate',{revision:c.revision,...body});
    if(result)setCredential('');
  }
  return <details className="space-y-4 border-t border-[var(--uoa-color-border)] pt-5">
    <summary className="min-h-11 cursor-pointer font-semibold">{t('maintenance')}</summary>
    <p>{t('rotationHint')}</p>
    <form className="space-y-3" onSubmit={event=>{event.preventDefault();void rotate();}}>
      {c.protocol==='oidc'?<Input type="password" autoComplete="new-password" required label={common('secret')}
        value={credential} disabled={busy} onChange={event=>setCredential(event.target.value)}/>:
        <label className="block text-sm font-medium">{common('certificate')}<textarea required rows={5}
          className={fieldInputClassName('font-mono text-xs')} value={credential} disabled={busy}
          onChange={event=>setCredential(event.target.value)}/></label>}
      <Button type="submit" disabled={busy||!credential}>{t('rotate')}</Button>
    </form>
    {c.protocol==='saml'&&<div className="space-y-3"><p>{t('keyHint')}</p>
      {c.metadata_url&&<CopyValue label={t('metadataUrl')} value={c.metadata_url}/>}
      <Button variant="secondary" disabled={busy||(c.sp_key_state!=='current'&&c.sp_key_state!==undefined)}
        onClick={()=>void mutate('POST',path+'/sp-key/prepare',{revision:c.revision})}>{t('prepareKey')}</Button>
      {c.sp_key_state==='prepared'&&<Button disabled={busy||!tested}
        onClick={()=>void mutate('POST',path+'/sp-key/activate',{revision:c.revision})}>{t('activateKey')}</Button>}
      {c.sp_key_state==='overlap'&&<Button disabled={busy||!tested}
        onClick={()=>void mutate('POST',path+'/sp-key/retire',{revision:c.revision})}>{t('retireKey')}</Button>}
      {c.key_overlap_expires_at&&<p>{t('overlapEnds')}: {new Date(c.key_overlap_expires_at).toLocaleString()}</p>}
    </div>}
  </details>;
}
