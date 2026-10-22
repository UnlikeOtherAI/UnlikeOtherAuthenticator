import {useState} from 'react';
import {useEnterpriseTranslation} from '../../i18n/enterprise-actions.js';
import {Button} from '../ui/Button.js';
import {fieldInputClassName} from '../ui/Input.js';
export type SamlMetadataFields={entity_id:string;sso_url:string;certificate:string};
export function SamlMetadata({parse,onImport,disabled}:{parse:(xml:string)=>Promise<SamlMetadataFields>;
  onImport:(fields:SamlMetadataFields)=>void;disabled:boolean}) {
  const t=useEnterpriseTranslation();const [xml,setXml]=useState('');const [busy,setBusy]=useState(false);
  const [error,setError]=useState(false);
  async function importXml() {
    setBusy(true);setError(false);
    try{if(new TextEncoder().encode(xml).length>256*1024)throw new Error('Metadata too large');
      onImport(await parse(xml));setXml('');}catch{setError(true);}finally{setBusy(false);}
  }
  return <section className="space-y-3 rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] p-4">
    <h3 className="font-semibold">{t('metadata')}</h3><p className="text-sm">{t('metadataHint')}</p>
    <label className="block text-sm font-medium">{t('metadataFile')}<input type="file" accept=".xml,application/xml,text/xml"
      className="block min-h-11 w-full py-2" disabled={disabled||busy} onChange={event=>{
        const file=event.target.files?.[0];setError(false);setXml('');
        if(!file)return;if(file.size>256*1024){setError(true);return;}
        void file.text().then(setXml,()=>setError(true));
      }}/></label>
    <textarea aria-label={t('metadata')} rows={4} value={xml} disabled={disabled||busy}
      className={fieldInputClassName('font-mono text-xs')} onChange={event=>setXml(event.target.value)}/>
    {error&&<p role="alert">{t('error')}</p>}
    <Button type="button" variant="secondary" disabled={disabled||busy||!xml} onClick={()=>void importXml()}>{t('metadataParse')}</Button>
  </section>;
}
