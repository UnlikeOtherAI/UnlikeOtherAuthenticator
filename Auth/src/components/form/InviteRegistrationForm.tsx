import React, { useState } from 'react';

import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';
import { checkPasswordPolicy } from '../../utils/password-policy.js';
import { PasswordRequirements } from './PasswordRequirements.js';
import { Button } from '../ui/Button.js';
import { PasswordInput } from '../ui/PasswordInput.js';

type VerifyInviteRequest = { token: string; password: string };
type VerifyInviteResponse = { invite_accepted?: boolean };

/** Password creation for a mail-bound invitation. The token—not this UI field—is the authority. */
export function InviteRegistrationForm(): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, inviteToken, setView } = usePopup();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!inviteToken) {
      setError(t('form.invite.error'));
      return;
    }
    if (!checkPasswordPolicy(password).valid) {
      setError(t('form.setPassword.tooShort'));
      return;
    }

    setLoading(true);
    const result = await postJson<VerifyInviteRequest, VerifyInviteResponse>(
      '/auth/verify-email',
      { token: inviteToken, password },
      { config_url: configUrl },
    );
    setLoading(false);
    if (!result.ok || result.data.invite_accepted !== true) {
      setError(t('form.invite.error'));
      return;
    }
    setView('invite-accepted');
  }

  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={handleSubmit}>
      <PasswordInput
        name="password"
        autoComplete="new-password"
        required
        minLength={8}
        label={t('form.newPassword.label')}
        showToggleLabel={t('form.password.show')}
        hideToggleLabel={t('form.password.hide')}
        value={password}
        onChange={(event) => setPassword(event.currentTarget.value)}
      />

      <PasswordRequirements password={password} />

      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.invite.submit')}
        </Button>
      </div>
    </form>
  );
}
