import React from 'react';

import { ResetPasswordForm } from '../components/form/ResetPasswordForm.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function ResetPasswordPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { setView } = usePopup();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.resetPassword.title')}</h1>
      <ResetPasswordForm />
      <div className="mt-4 text-center text-sm">
        <button
          type="button"
          className="text-[var(--uoa-color-primary)] hover:underline"
          onClick={() => setView('login')}
        >
          {t('nav.backToLogin')}
        </button>
      </div>
    </div>
  );
}
