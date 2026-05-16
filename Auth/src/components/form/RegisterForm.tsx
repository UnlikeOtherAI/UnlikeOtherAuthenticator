import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';

type RegisterRequest = { email: string };

export function RegisterForm(): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess } = usePopup();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const query: Record<string, string | boolean | null> = { config_url: configUrl };
    if (redirectUrl) query.redirect_url = redirectUrl;
    if (codeChallenge && codeChallengeMethod) {
      query.code_challenge = codeChallenge;
      query.code_challenge_method = codeChallengeMethod;
    }
    if (requestAccess) query.request_access = true;

    // Always render the same confirmation regardless of result — avoids
    // account-existence enumeration via timing or message differences.
    await postJson<RegisterRequest, unknown>('/auth/register', { email }, query);
    setLoading(false);
    setSubmitted(true);
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
    <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
      <Input
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        label={t('form.email.label')}
        value={email}
        onChange={(e) => setEmail(e.currentTarget.value)}
      />

      <div className="mt-2">
        <Button variant="primary" type="submit" disabled={loading}>
          {loading ? '...' : t('form.register.submit')}
        </Button>
      </div>
    </form>
  );
}
