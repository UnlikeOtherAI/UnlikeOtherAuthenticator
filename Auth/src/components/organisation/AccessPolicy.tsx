import {useState} from 'react';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {useAccessTranslation} from '../../hooks/use-access-translation.js';
import {accessMutation,type AccessSettings} from '../../utils/organisation-access.js';
import {Button} from '../ui/Button.js';
import {Input,fieldInputClassName} from '../ui/Input.js';
export function AccessPolicy({settings,onSaved,onConnect}:{settings:AccessSettings;onSaved:()=>Promise<void>;onConnect:()=>void}) {
  const t=useEnterpriseTranslation();const common=useAccessTranslation();const p=settings.policy;
  const [enforcement,setEnforcement]=useState(p.enforcement);const [jit,setJit]=useState(p.jit_enabled);
  const [team,setTeam]=useState(p.default_team_id??'');const [contractors,setContractors]=useState(p.allow_unverified_contractors);
  const [discovery,setDiscovery]=useState(p.discovery_enabled);const [groups,setGroups]=useState(p.group_mappings);
  const [busy,setBusy]=useState(false);const [error,setError]=useState(false);const [saved,setSaved]=useState(false);
  async function save() {
    setBusy(true);setError(false);setSaved(false);
    try {await accessMutation(settings,'PATCH','/policy',{revision:p.revision,enforcement,jit_enabled:jit,
      default_team_id:team||null,allow_unverified_contractors:contractors,discovery_enabled:discovery,group_mappings:groups});
      await onSaved();setSaved(true);
    }catch{setError(true);}finally{setBusy(false);}
  }
  const teamOptions=<><option value="">{t('chooseTeam')}</option>{settings.teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</>;
  return <form className="space-y-5" onSubmit={event=>{event.preventDefault();void save();}}>
    <h2 className="text-xl font-semibold">{t('accessPolicy')}</h2><p>{t('policyHint')}</p>
    {error&&<p role="alert">{common('saveError')}</p>}{saved&&<p role="status">{t('policySaved')}</p>}
    <label className="block text-sm font-medium">{t('requiredSignIn')}<select className={fieldInputClassName()} value={enforcement}
      disabled={busy} onChange={event=>setEnforcement(event.target.value)}>
      <option value="off">{t('optional')}</option>
      <option value="required_for_verified_domains" disabled={!settings.readiness.enforcement_allowed}>{t('verifiedRequired')}</option>
      <option value="required_for_all_members" disabled={!settings.readiness.enforcement_allowed}>{t('allRequired')}</option>
    </select></label>
    {!settings.readiness.enforcement_allowed&&<p className="text-sm">{common(settings.readiness.blockers.some(code=>code.startsWith('RECOVERY_'))?'recovery':'blocked')}</p>}
    <label className="flex items-start gap-3"><input type="checkbox" checked={jit} disabled={busy}
      onChange={event=>setJit(event.target.checked)}/><span>{t('join')}</span></label>
    {jit&&<label className="block text-sm font-medium">{t('defaultTeam')}<select aria-label={t('defaultTeam')} required className={fieldInputClassName()} value={team}
      disabled={busy} onChange={event=>setTeam(event.target.value)}>{teamOptions}</select></label>}
    <label className="flex items-start gap-3"><input type="checkbox" checked={contractors} disabled={busy}
      onChange={event=>setContractors(event.target.checked)}/><span>{t('contractors')}</span></label>
    <label className="flex items-start gap-3"><input type="checkbox" checked={discovery} disabled={busy}
      onChange={event=>setDiscovery(event.target.checked)}/><span>{t('discovery')}</span></label>
    {(p.invalid_group_mappings??0)>0&&<p role="alert">{t('repairMappings')}</p>}
    <details className="space-y-4" open={(p.invalid_group_mappings??0)>0?true:undefined}><summary className="min-h-11 cursor-pointer font-semibold">{t('mappings')}</summary>
      <p className="text-sm">{t('mappingHint')}</p>{groups.map((mapping,index)=><div key={index} className="space-y-3 border-t border-[var(--uoa-color-border)] pt-3">
        <label className="block text-sm">{t('mappingProvider')}<select required aria-label={t('mappingProvider')}
          className={fieldInputClassName()} value={mapping.connection_id} disabled={busy}
          onChange={event=>setGroups(previous=>previous.map((item,i)=>i===index?{...item,connection_id:event.target.value}:item))}>
          <option value="">—</option>{settings.connections.map(connection=><option key={connection.id} value={connection.id}>{connection.display_name}</option>)}
        </select></label>
        <Input required label={t('groupId')} value={mapping.external_group_id} disabled={busy}
          onChange={event=>setGroups(previous=>previous.map((item,i)=>i===index?{...item,external_group_id:event.target.value}:item))}/>
        <label className="block text-sm">{t('groupTeam')}<select aria-label={t('groupTeam')} required className={fieldInputClassName()} value={mapping.team_id} disabled={busy}
          onChange={event=>setGroups(previous=>previous.map((item,i)=>i===index?{...item,team_id:event.target.value}:item))}>{teamOptions}</select></label>
        <select aria-label={t('teamRole')} className={fieldInputClassName()} value={mapping.team_role} disabled={busy}
          onChange={event=>{const role=event.target.value;if(role==='member'||role==='admin')setGroups(previous=>previous.map((item,i)=>i===index?{...item,team_role:role}:item));}}>
          <option value="member">{t('memberRole')}</option><option value="admin">{t('adminRole')}</option></select>
        <Button type="button" variant="secondary" disabled={busy} onClick={()=>setGroups(previous=>previous.filter((_,i)=>i!==index))}>{t('removeMapping')}</Button>
      </div>)}{settings.connections.length===0?<><p>{t('connectBeforeGroups')}</p><Button type="button" variant="secondary" onClick={onConnect}>{common('choose')}</Button></>:<Button type="button" variant="secondary" disabled={busy||groups.length>=100}
        onClick={()=>setGroups(previous=>[...previous,{connection_id:'',external_group_id:'',team_id:'',team_role:'member'}])}>{t('addMapping')}</Button>}
    </details>
    <p className="text-sm text-[var(--uoa-color-muted)]">{t('policyChangeHint')}</p>
    <Button type="submit" disabled={busy||jit&&!team}>{t('savePolicy')}</Button>
  </form>;
}
