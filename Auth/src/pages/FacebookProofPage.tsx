import React, { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { CodeInput } from '../components/ui/CodeInput.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function FacebookProofPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { redirectTo, setView } = usePopup();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(false);
    try {
      const response = await fetch('/auth/facebook-proof/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) throw new Error('verification failed');
      const result: unknown = await response.json();
      const redirectUrl = (result as { redirect_url?: unknown })?.redirect_url;
      if (typeof redirectUrl !== 'string' || !redirectUrl.startsWith(`${window.location.origin}/auth/callback/facebook?`)) {
        throw new Error('invalid redirect');
      }
      redirectTo(redirectUrl);
    } catch {
      setError(true);
      setSubmitting(false);
    }
  }

  return <div>
    <h1 className={`text-balance ${classNames.title}`}>{t('auth.codeEntry.title')}</h1>
    <p className="mt-2 text-sm text-[var(--uoa-color-muted)]">{t('message.instructionsSent')}</p>
    <form className="mt-6 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <CodeInput value={code} onChange={setCode} length={6} disabled={submitting}
        autoFocus label={t('twoFactor.code.label')} />
      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{t('codeEntry.error')}</p> : null}
      <Button variant="primary" type="submit" disabled={submitting || code.length !== 6}>
        {submitting ? '...' : t('codeEntry.submit')}
      </Button>
    </form>
    <button type="button" className="mt-4 text-sm text-[var(--uoa-color-primary)] hover:underline"
      onClick={() => setView('login')}>{t('nav.backToLogin')}</button>
  </div>;
}
