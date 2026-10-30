import React, { useState } from 'react';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { postJson } from '../utils/api.js';

export function AccountRenewalPage(): React.JSX.Element {
  const { configUrl, pendingEmail, setView } = usePopup();
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const [email, setEmail] = useState(pendingEmail ?? '');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    const result = challengeId
      ? await postJson('/auth/account-renewal/request', { challengeId, code, ...(twoFactorCode ? { twoFactorCode } : {}) },
        { config_url: configUrl })
      : await postJson<{ email: string }, { challengeId: string }>('/auth/account-renewal/start',
        { email: email.trim() }, { config_url: configUrl });
    setBusy(false);
    if (!result.ok) { setError(true); return; }
    if (challengeId) setSent(true);
    else setChallengeId((result.data as { challengeId: string }).challengeId);
  }

  return <div className="flex flex-col gap-4">
    <h1 className={`text-balance ${classNames.title}`}>{t('auth.renewal.title')}</h1>
    <p className="text-sm text-[var(--uoa-color-muted)]">{t('auth.renewal.description')}</p>
    {sent ? <p role="status" className="text-sm">{t('auth.renewal.sent')}</p> :
      <form className="flex flex-col gap-4" onSubmit={event => { void submit(event); }}>
        {!challengeId ? <Input label={t('form.email.label')} type="email" autoComplete="email" required value={email}
          onChange={event => setEmail(event.currentTarget.value)} /> : <>
          <p role="status" className="text-sm">{t('auth.renewal.codeSent')}</p>
          <Input label={t('auth.accessStatus.code')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            required value={code} onChange={event => setCode(event.currentTarget.value)} />
          <Input label={t('auth.accessStatus.totp')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            value={twoFactorCode} onChange={event => setTwoFactorCode(event.currentTarget.value)} />
        </>}
        {error ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t('auth.renewal.error')}</p> : null}
        <Button type="submit" disabled={busy}>{busy ? '…' : t(challengeId ? 'auth.renewal.submit' : 'auth.accessStatus.send')}</Button>
        {challengeId ? <Button type="button" variant="secondary" onClick={() => { setChallengeId(null); setCode(''); setTwoFactorCode(''); setError(false); }}>
          {t('auth.accessStatus.restart')}</Button> : null}
      </form>}
    <Button type="button" variant="secondary" onClick={() => setView('login')}>{t('auth.renewal.back')}</Button>
  </div>;
}
