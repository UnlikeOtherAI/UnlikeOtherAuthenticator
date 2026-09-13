import React, { useState } from 'react';

import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';
import { checkPasswordPolicy } from '../../utils/password-policy.js';
import { PasswordRequirements } from './PasswordRequirements.js';
import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { PasswordInput } from '../ui/PasswordInput.js';

type VerifyInviteRequest = { token: string; password: string; name?: string };
type VerifyInviteResponse = { invite_accepted?: boolean };

/** Password creation for a mail-bound invitation. The token—not this UI field—is the authority. */
export function InviteRegistrationForm(): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, inviteToken, setView } = usePopup();
  const [name, setName] = useState('');
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
    // F6: optional. Left empty, the invitation's own `inviteName` still backfills the
    // account, and a name the invitee already has is never touched either way.
    const declaredName = name.trim();
    const result = await postJson<VerifyInviteRequest, VerifyInviteResponse>(
      '/auth/verify-email',
      { token: inviteToken, password, ...(declaredName ? { name: declaredName } : {}) },
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
      <Input
        name="name"
        autoComplete="name"
        maxLength={120}
        label={t('form.name.label')}
        placeholder={t('form.name.placeholder')}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />

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
