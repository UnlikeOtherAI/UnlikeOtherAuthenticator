import React from 'react';

import { SetPasswordForm } from '../components/form/SetPasswordForm.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function SetPasswordPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.setPassword.title')}</h1>
      <SetPasswordForm />
    </div>
  );
}
