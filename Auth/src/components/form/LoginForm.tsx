import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Switch } from '../ui/Switch.js';
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

function readSessionConfig(config: unknown): {
  rememberMeEnabled: boolean;
  rememberMeDefault: boolean;
} {
  if (config && typeof config === 'object' && 'session' in config) {
    const s = (config as Record<string, unknown>).session;
    if (s && typeof s === 'object') {
      const session = s as Record<string, unknown>;
      return {
        rememberMeEnabled: session.remember_me_enabled !== false,
        rememberMeDefault: session.remember_me_default !== false,
      };
    }
  }
  return { rememberMeEnabled: true, rememberMeDefault: true };
}

export function LoginForm(): React.JSX.Element {
  const emailId = useId();
  const passwordId = useId();
  const rememberMeId = useId();
  const { t } = useTranslation();
  const { configUrl, config, redirectUrl, redirectTo, setView, requestAccess } = usePopup();
  const { rememberMeEnabled, rememberMeDefault } = readSessionConfig(config);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberMeDefault);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const url = new URL('/auth/login', window.location.origin);
      url.searchParams.set('config_url', configUrl);
      if (redirectUrl) {
        url.searchParams.set('redirect_url', redirectUrl);
      }
      if (requestAccess) {
        url.searchParams.set('request_access', 'true');
      }

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        setError(t('form.login.error'));
        return;
      }

      if (data.twofa_required && typeof data.twofa_token === 'string') {
        // 2FA required: update URL to trigger the 2FA view
        const twofaUrl = new URL(window.location.href);
        twofaUrl.searchParams.set('twofa_token', data.twofa_token);
        window.location.assign(twofaUrl.toString());
        return;
      }

      if (typeof data.redirect_to === 'string') {
        redirectTo(data.redirect_to);
        return;
      }

      setError(t('form.login.error'));
    } catch {
      setError(t('form.login.error'));
    } finally {
      setLoading(false);
    }
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

      <div>
        <label htmlFor={passwordId} className="text-sm font-medium">
          {t('form.password.label')}
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldInputClasses()}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>

      {rememberMeEnabled && (
        <Switch
          id={rememberMeId}
          checked={rememberMe}
          onChange={setRememberMe}
          label={t('form.rememberMe.label')}
        />
      )}

      {error && (
        <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p>
      )}

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.login.submit')}
        </Button>
      </div>

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-[var(--uoa-color-primary)] hover:underline"
          onClick={() => setView('reset-password')}
        >
          {t('nav.forgotPassword')}
        </button>
        <button
          type="button"
          className="text-[var(--uoa-color-primary)] hover:underline"
          onClick={() => setView('register')}
        >
          {t('nav.createAccount')}
        </button>
      </div>
    </form>
  );
}
