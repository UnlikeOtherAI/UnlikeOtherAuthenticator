import { useState } from 'react';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import type { AccessSettings } from '../../utils/organisation-access.js';
import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { CopyValue } from './CopyValue.js';

export function AccessDomains(props: {
  settings: AccessSettings; busy: boolean;
  mutate: (method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<void>;
}) {
  const t = useAccessTranslation();
  const [domain, setDomain] = useState('');
  return <section className="space-y-5">
    <h2 className="text-xl font-semibold">{t('domains')}</h2><p>{t('domainIntro')}</p>
    {props.settings.domains.map((item) => <div key={item.id} className="space-y-3 border-t border-[var(--uoa-color-border)] pt-4">
      <h3 className="break-all font-medium">{item.email_domain}</h3>
      <p>{t(item.status.toLowerCase() === 'verified' ? 'verified' : 'pending')}</p>
      {item.challenge && <><p className="text-sm">{t('dns')}</p>
        <CopyValue label={t('recordName')} value={item.challenge.name} />
        <CopyValue label={t('recordValue')} value={item.challenge.value} />
      </>}
      {item.status.toLowerCase() !== 'verified' && <Button variant="secondary" disabled={props.busy}
        onClick={() => void props.mutate('POST', `/domains/${encodeURIComponent(item.id)}/verify`)}>{t('verify')}</Button>}
    </div>)}
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      void props.mutate('POST', '/domains', { email_domain: domain }).then(() => setDomain(''));
    }}>
      <Input label={t('domain')} value={domain} required autoComplete="off" placeholder="example.com"
        onChange={(event) => setDomain(event.target.value)} />
      <Button disabled={props.busy}>{t('addDomain')}</Button>
    </form>
  </section>;
}
