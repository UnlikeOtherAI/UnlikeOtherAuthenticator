import React, { useEffect, useState } from 'react';

import { Button } from '../ui/Button.js';
import { PasswordInput } from '../ui/PasswordInput.js';
import { PasswordRequirements } from './PasswordRequirements.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson, type ApiResult } from '../../utils/api.js';
import { checkPasswordPolicy } from '../../utils/password-policy.js';

type SetPasswordRequest = { token: string; password: string };
type SetPasswordResponse = { redirect_to?: string };

export function SetPasswordForm(): React.JSX.Element {
  const { t } = useTranslation();
  const {
    configUrl,
    redirectUrl,
    codeChallenge,
    codeChallengeMethod,
    redirectTo,
    emailToken,
    emailTokenType,
    setView,
    requestAccess,
  } = usePopup();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  // This view is server-rendered, so the password inputs exist as focusable HTML
  // before the JS bundle hydrates. On mobile a user can tap and type into a
  // not-yet-hydrated input; when React then hydrates the controlled input (initial
  // value ''), it wipes that first character and the focus reconciliation dismisses
  // the soft keyboard (observed on iOS Chrome/WebKit). Gating the controls behind a
  // post-hydration flag keeps them non-focusable until React owns them, which removes
  // the race. Server render and first client render both emit disabled controls, so
  // hydration markup matches.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  const isPasswordReset = emailTokenType === 'PASSWORD_RESET';

  function failure(result: ApiResult<unknown>): void {
    if (result.ok) return;

    switch (result.code) {
      case 'PASSWORD_POLICY_VIOLATION':
      case 'MISSING_PASSWORD':
        setError(t('form.setPassword.tooShort'));
        return;
      case 'INVALID_TOKEN':
      case 'INVALID_TOKEN_TYPE':
      case 'INVALID_TOKEN_CONFIG_URL':
      case 'INVALID_TOKEN_USER':
      case 'TOKEN_EXPIRED':
      case 'TOKEN_ALREADY_USED':
        setError(t('form.setPassword.linkInvalid'));
        return;
      default:
        setError(t('form.setPassword.error'));
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError(t('form.setPassword.mismatch'));
      return;
    }

    if (!checkPasswordPolicy(password).valid) {
      setError(t('form.setPassword.tooShort'));
      return;
    }

    if (!emailToken) {
      setError(t('form.setPassword.linkInvalid'));
      return;
    }

    setLoading(true);

    if (isPasswordReset) {
      const result = await postJson<SetPasswordRequest, unknown>(
        '/auth/reset-password',
        { token: emailToken, password },
        { config_url: configUrl },
      );
      setLoading(false);
      if (!result.ok) {
        failure(result);
        return;
      }
      // Password reset doesn't issue an auth code — user must re-login.
      setSuccess(true);
      return;
    }

    const query: Record<string, string | boolean | null> = { config_url: configUrl };
    if (redirectUrl) query.redirect_url = redirectUrl;
    if (codeChallenge && codeChallengeMethod) {
      query.code_challenge = codeChallenge;
      query.code_challenge_method = codeChallengeMethod;
    }
    if (requestAccess) query.request_access = true;

    const result = await postJson<SetPasswordRequest, SetPasswordResponse>(
      '/auth/verify-email',
      { token: emailToken, password },
      query,
    );
    setLoading(false);

    if (!result.ok) {
      failure(result);
      return;
    }

    if (typeof result.data.redirect_to === 'string') {
      redirectTo(result.data.redirect_to);
      return;
    }

    setError(t('form.setPassword.error'));
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
    <form className="mt-6" onSubmit={handleSubmit}>
      <fieldset
        disabled={!hydrated}
        aria-busy={!hydrated || undefined}
        className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0"
      >
        <PasswordInput
          name="password"
          autoComplete="new-password"
          required
          minLength={8}
          label={t('form.newPassword.label')}
          showToggleLabel={t('form.password.show')}
          hideToggleLabel={t('form.password.hide')}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />

        <PasswordRequirements password={password} />

        <PasswordInput
          name="confirm-password"
          autoComplete="new-password"
          required
          minLength={8}
          label={t('form.confirmPassword.label')}
          showToggleLabel={t('form.password.show')}
          hideToggleLabel={t('form.password.hide')}
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
        />

        {error && <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p>}

        <div className="mt-2">
          <Button variant="primary" type="submit" disabled={!hydrated || loading}>
            {loading ? '...' : t('form.setPassword.submit')}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
