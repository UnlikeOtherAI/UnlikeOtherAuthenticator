import React, { useEffect, useState } from 'react';

import { TwoFactorInput } from '../form/TwoFactorInput.js';
import { Button } from '../ui/Button.js';
import { QrCodeDisplay } from './QrCodeDisplay.js';
import { usePopup, type TwoFactorSetupState } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import { postJson } from '../../utils/api.js';

type SetupResponse = TwoFactorSetupState;

type EnrollResponse = {
  ok: true;
  redirect_to?: string;
};

export function TwoFactorSetup(): React.JSX.Element {
  const { t } = useTranslation();
  const { configUrl, redirectTo, twoFactorSetup } = usePopup();
  const [setup, setSetup] = useState<TwoFactorSetupState | null>(twoFactorSetup);
  const [code, setCode] = useState('');
  const [loadingSetup, setLoadingSetup] = useState(Boolean(twoFactorSetup && !twoFactorSetup.qr_svg));
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSetup() {
      if (!twoFactorSetup?.setup_token || twoFactorSetup.qr_svg) return;

      setLoadingSetup(true);
      const result = await postJson<{ setup_token: string }, SetupResponse>(
        '/2fa/setup',
        { setup_token: twoFactorSetup.setup_token },
        { config_url: configUrl },
      );

      if (cancelled) return;
      setLoadingSetup(false);

      if (!result.ok) {
        setError(t('twoFactor.setup.error'));
        return;
      }

      setSetup(result.data);
    }

    void loadSetup();

    return () => {
      cancelled = true;
    };
  }, [configUrl, t, twoFactorSetup]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!setup?.setup_token) {
      setError(t('twoFactor.setup.error'));
      return;
    }

    setError(null);
    setSubmitting(true);
    const result = await postJson<{ setup_token: string; code: string }, EnrollResponse>(
      '/2fa/enroll',
      { setup_token: setup.setup_token, code },
      { config_url: configUrl },
    );
    setSubmitting(false);

    if (!result.ok) {
      setError(t('twoFactor.setup.error'));
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
        {t('twoFactor.setup.instructions')}
      </p>

      <QrCodeDisplay
        src={setup?.qr_svg}
        alt={t('twoFactor.qr.alt')}
        placeholder={loadingSetup ? t('twoFactor.setup.loading') : t('twoFactor.qr.placeholder')}
      />

      {setup?.manual_secret ? (
        <p className="break-all rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] px-3 py-2 text-xs text-[var(--uoa-color-muted)]">
          <span className="font-medium text-[var(--uoa-color-text)]">{t('twoFactor.setup.manual')}</span>{' '}
          <code>{setup.manual_secret}</code>
        </p>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <TwoFactorInput
          value={code}
          onChange={setCode}
          digits={6}
          disabled={done || submitting || loadingSetup}
          label={t('twoFactor.code.label')}
        />

        {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

        <div className="mt-2">
          <Button variant="primary" type="submit" disabled={done || submitting || loadingSetup || code.length !== 6}>
            {submitting ? '...' : t('twoFactor.setup.submit')}
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
            {t('twoFactor.setup.success')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
