import React from 'react';

import { RegisterForm } from '../components/form/RegisterForm.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function RegisterPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.register.title')}</h1>
      <RegisterForm />
    </div>
  );
}
