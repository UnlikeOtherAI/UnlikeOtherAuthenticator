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
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    const result = await postJson<{ email: string }, { ok: true }>('/auth/account-renewal/request',
      { email: email.trim() }, { config_url: configUrl });
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(true);
  }

  return <div className="flex flex-col gap-4">
    <h1 className={`text-balance ${classNames.title}`}>{t('auth.renewal.title')}</h1>
    <p className="text-sm text-[var(--uoa-color-muted)]">{t('auth.renewal.description')}</p>
    {sent ? <p role="status" className="text-sm">{t('auth.renewal.sent')}</p> :
      <form className="flex flex-col gap-4" onSubmit={event => { void submit(event); }}>
        <Input label={t('form.email.label')} type="email" autoComplete="email" required value={email}
          onChange={event => setEmail(event.currentTarget.value)} />
        {error ? <p role="alert" className="text-sm text-[var(--uoa-color-danger)]">{t('auth.renewal.error')}</p> : null}
        <Button type="submit" disabled={busy}>{busy ? '…' : t('auth.renewal.submit')}</Button>
      </form>}
    <Button type="button" variant="secondary" onClick={() => setView('login')}>{t('auth.renewal.back')}</Button>
  </div>;
}
