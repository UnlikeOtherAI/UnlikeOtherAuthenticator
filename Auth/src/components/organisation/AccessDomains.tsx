import { useState } from 'react';
import { useAccessTranslation } from '../../hooks/use-access-translation.js';
import type { AccessSettings, EmailDomain } from '../../utils/organisation-access.js';
import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { CopyValue } from './CopyValue.js';

export function AccessDomains(props: {
  settings: AccessSettings; busy: boolean;
  mutate: (method: 'POST' | 'DELETE', path: string, body?: unknown) => Promise<Record<string, unknown> | undefined>;
}) {
  const t = useAccessTranslation();
  const [domain, setDomain] = useState('');
  const [challenges, setChallenges] = useState<Record<string, EmailDomain['challenge']>>({});
  function remember(result: Record<string, unknown> | undefined) {
    const value = result?.domain;
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string' ||
      !('challenge' in value) || !value.challenge || typeof value.challenge !== 'object') return;
    const challenge = value.challenge;
    if (!('name' in challenge) || typeof challenge.name !== 'string' || !('value' in challenge) ||
      typeof challenge.value !== 'string' || !('expires_at' in challenge) || typeof challenge.expires_at !== 'string') return;
    setChallenges((current) => ({ ...current, [value.id as string]: challenge as EmailDomain['challenge'] }));
  }
  return <section className="space-y-5">
    <h2 className="text-xl font-semibold">{t('domains')}</h2><p>{t('domainIntro')}</p>
    {props.settings.domains.map((item) => {
      const challenge = item.challenge ?? challenges[item.id];
      const status = item.status.toLowerCase();
      return <div key={item.id} className="space-y-3 border-t border-[var(--uoa-color-border)] pt-4">
      <h3 className="break-all font-medium">{item.email_domain}</h3>
      <p>{t(status === 'verified' ? 'verified' : status === 'expired' ? 'domainExpired' : status === 'revoked' ? 'domainRevoked' : status === 'suspended' ? 'suspended' : 'pending')}</p>
      {challenge && status === 'pending' && <><p className="text-sm">{t('dns')}</p><p className="text-sm">{t('dnsOnce')}</p>
        <CopyValue label={t('recordName')} value={challenge.name} />
        <CopyValue label={t('recordValue')} value={challenge.value} />
      </>}
      {status === 'pending' && <Button variant="secondary" disabled={props.busy}
        onClick={() => void props.mutate('POST', `/domains/${encodeURIComponent(item.id)}/verify`)}>{t('verify')}</Button>}
      {((status === 'pending' && !challenge) || status === 'expired') && <Button variant="secondary" disabled={props.busy}
        onClick={() => void props.mutate('POST', `/domains/${encodeURIComponent(item.id)}/reissue`).then(remember)}>{t('reissueDns')}</Button>}
    </div>; })}
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      void props.mutate('POST', '/domains', { email_domain: domain }).then((result) => {
        if (result) { remember(result); setDomain(''); }
      });
    }}>
      <Input label={t('domain')} value={domain} required autoComplete="off" placeholder="example.com"
        onChange={(event) => setDomain(event.target.value)} />
      <Button disabled={props.busy}>{t('addDomain')}</Button>
    </form>
  </section>;
}
