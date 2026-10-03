import React, { useState } from 'react';
import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';

type EntityStatus = { id: string; name?: string; status: string; reason: string | null };
type StatusResult = { user: EntityStatus; organisations: EntityStatus[]; teams: (EntityStatus & { parent: EntityStatus })[] };
export function AccessStatusForm(): React.JSX.Element | null {
  const { configUrl, clientId, redirectUrl } = usePopup();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null), [code, setCode] = useState(''), [totp, setTotp] = useState('');
  const [result, setResult] = useState<StatusResult | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  if (!configUrl && !clientId) return null;
  const prefix = clientId ? '/oauth' : '/auth';
  const query = clientId ? { client_id: clientId, redirect_uri: redirectUrl } : { config_url: configUrl };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    try {
      if (!challengeId) {
        const response = await postJson<{ email: string }, { challengeId: string }>(`${prefix}/lifecycle-status/start`, { email }, query);
        if (!response.ok) setError(t('auth.accessStatus.failed'));
        else setChallengeId(response.data.challengeId);
      } else {
        const response = await postJson<{ challengeId: string; code: string; twoFactorCode?: string }, StatusResult>(`${prefix}/lifecycle-status/verify`, { challengeId, code, ...(totp ? { twoFactorCode: totp } : {}) }, query);
        if (!response.ok) setError(t('auth.accessStatus.failed'));
        else setResult(response.data);
      }
    } finally { setPending(false); }
  }
  return <div className="mt-5 border-t border-[var(--uoa-color-border)] pt-4">
    <Button variant="secondary" type="button" disabled={pending} onClick={() => setOpen(!open)}>{t('auth.accessStatus.open')}</Button>
    {open ? <div className="mt-3 space-y-3">
      <p className="text-sm">{t('auth.accessStatus.description')}</p>
      {error ? <p role="alert">{error}</p> : null}
      {!result ? <form className="space-y-3" onSubmit={event => void submit(event)}>
        {!challengeId ? <Input label={t('auth.accessStatus.email')} type="email" required value={email} disabled={pending} onChange={event => setEmail(event.target.value)} /> : <>
          <p role="status">{t('auth.accessStatus.sent')}</p>
          <Input label={t('auth.accessStatus.code')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={pending} onChange={event => setCode(event.target.value)} />
          <Input label={t('auth.accessStatus.totp')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={totp} disabled={pending} onChange={event => setTotp(event.target.value)} />
        </>}
        <Button type="submit" disabled={pending}>{t(challengeId ? 'auth.accessStatus.verify' : 'auth.accessStatus.send')}</Button>
        {challengeId ? <Button type="button" variant="secondary" disabled={pending} onClick={() => { setChallengeId(null); setCode(''); setTotp(''); setError(''); }}>{t('auth.accessStatus.restart')}</Button> : null}
      </form> : <div role="status" className="space-y-2">
        <p>{t('auth.accessStatus.account')}: {result.user.status.toLowerCase()} {result.user.reason}</p>
        {result.organisations.map(org => <p key={org.id}>{t('auth.accessStatus.organisation')} {org.name ?? org.id}: {org.status.toLowerCase()} {org.reason}</p>)}
        {result.teams.map(team => <p key={team.id}>{t('auth.accessStatus.team')} {team.name ?? team.id}: {team.status.toLowerCase()} {team.reason}{team.parent.status !== 'ACTIVE' ? ` (${t('auth.accessStatus.parent')}: ${team.parent.name ?? team.parent.id} — ${team.parent.reason ?? team.parent.status.toLowerCase()})` : ''}</p>)}
      </div>}
    </div> : null}
  </div>;
}
