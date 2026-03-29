import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';

function fieldInputClasses(): string {
  return [
    'mt-1 w-full rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)]',
    'bg-[var(--uoa-color-surface)] px-3 py-2 text-[var(--uoa-color-text)]',
    'placeholder:text-[var(--uoa-color-muted)]',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
  ].join(' ');
}

export function RegisterForm(): React.JSX.Element {
  const emailId = useId();
  const { t } = useTranslation();
  const { configUrl, redirectUrl, requestAccess } = usePopup();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    try {
      const url = new URL('/auth/register', window.location.origin);
      url.searchParams.set('config_url', configUrl);
      if (redirectUrl) {
        url.searchParams.set('redirect_url', redirectUrl);
      }
      if (requestAccess) {
        url.searchParams.set('request_access', 'true');
      }

      await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Swallow — always show the same message to avoid account-existence hints.
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <p
        role="status"
        className={[
          'mt-6 rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
          'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
        ].join(' ')}
      >
        {t('message.instructionsSent')}
      </p>
    );
  }

  return (
    <form
      className="mt-6 flex flex-col gap-4"
      onSubmit={handleSubmit}
    >
      <div>
        <label htmlFor={emailId} className="text-sm font-medium">
          {t('form.email.label')}
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          className={fieldInputClasses()}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </div>

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.register.submit')}
        </Button>
      </div>
    </form>
  );
}
