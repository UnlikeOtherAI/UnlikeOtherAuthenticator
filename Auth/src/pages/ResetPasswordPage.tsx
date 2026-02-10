import React from 'react';

import { ResetPasswordForm } from '../components/form/ResetPasswordForm.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function ResetPasswordPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.resetPassword.title')}</h1>
      <ResetPasswordForm />
    </div>
  );
}
