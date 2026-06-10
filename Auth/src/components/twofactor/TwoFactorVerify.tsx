import React, { useState } from 'react';

import { TwoFactorInput } from '../form/TwoFactorInput.js';
import { Button } from '../ui/Button.js';
import { usePopup } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';

type VerifyResponse = {
  ok: true;
  redirect_to?: string;
};

export function TwoFactorVerify(): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, redirectTo, twoFaToken } = usePopup();
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!twoFaToken) {
      setError(t('twoFactor.verify.error'));
      return;
    }

    setError(null);
    setSubmitting(true);
    const result = await postJson<{ twofa_token: string; code: string }, VerifyResponse>(
      '/2fa/verify',
      { twofa_token: twoFaToken, code },
      { config_url: configUrl },
    );
    setSubmitting(false);

    if (!result.ok) {
      setError(t('twoFactor.verify.error'));
      return;
    }

    setDone(true);
    if (typeof result.data.redirect_to === 'string') {
      redirectTo(result.data.redirect_to);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm text-[var(--uoa-color-muted)]">
        {t('twoFactor.verify.instructions')}
      </p>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <TwoFactorInput
          value={code}
          onChange={setCode}
          digits={6}
          disabled={done || submitting}
          label={t('twoFactor.code.label')}
        />

        {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

        <div className="mt-2">
          <Button variant="primary" type="submit" disabled={done || submitting || code.length !== 6}>
            {submitting ? '...' : t('twoFactor.verify.submit')}
          </Button>
        </div>

        {done ? (
          <p
            role="status"
            className={[
              'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
              'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
            ].join(' ')}
          >
            {t('twoFactor.verify.success')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
