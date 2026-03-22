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

export function SetPasswordForm(): React.JSX.Element {
  const passwordId = useId();
  const confirmId = useId();
  const { t } = useTranslation();
  const { configUrl, redirectUrl, redirectTo, emailToken, emailTokenType, setView } = usePopup();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const isPasswordReset = emailTokenType === 'PASSWORD_RESET';

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError(t('form.setPassword.mismatch'));
      return;
    }

    if (!emailToken) {
      setError(t('form.setPassword.error'));
      return;
    }

    setLoading(true);

    try {
      if (isPasswordReset) {
        // Password reset flow: POST /auth/reset-password
        const url = new URL('/auth/reset-password', window.location.origin);
        url.searchParams.set('config_url', configUrl);

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: emailToken, password }),
        });

        if (!response.ok) {
          setError(t('form.setPassword.error'));
          return;
        }

        // Password reset doesn't issue an auth code — user must re-login.
        setSuccess(true);
      } else {
        // Registration verify+set-password flow: POST /auth/verify-email
        const url = new URL('/auth/verify-email', window.location.origin);
        url.searchParams.set('config_url', configUrl);
        if (redirectUrl) {
          url.searchParams.set('redirect_url', redirectUrl);
        }

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: emailToken, password }),
        });

        const data = await response.json() as Record<string, unknown>;

        if (!response.ok) {
          setError(t('form.setPassword.error'));
          return;
        }

        if (typeof data.redirect_to === 'string') {
          redirectTo(data.redirect_to);
          return;
        }

        setError(t('form.setPassword.error'));
      }
    } catch {
      setError(t('form.setPassword.error'));
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <p
          role="status"
          className={[
            'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
            'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
          ].join(' ')}
        >
          {t('form.setPassword.success')}
        </p>
        <button
          type="button"
          className="text-sm text-[var(--uoa-color-primary)] hover:underline"
          onClick={() => setView('login')}
        >
          {t('nav.backToLogin')}
        </button>
      </div>
    );
  }

  return (
    <form
      className="mt-6 flex flex-col gap-4"
      onSubmit={handleSubmit}
    >
      <div>
        <label htmlFor={passwordId} className="text-sm font-medium">
          {t('form.newPassword.label')}
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={fieldInputClasses()}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>

      <div>
        <label htmlFor={confirmId} className="text-sm font-medium">
          {t('form.confirmPassword.label')}
        </label>
        <input
          id={confirmId}
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={fieldInputClasses()}
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
        />
      </div>

      {error && (
        <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p>
      )}

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.setPassword.submit')}
        </Button>
      </div>
    </form>
  );
}
