import React from 'react';

import { LoginForm } from '../components/form/LoginForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.login.title')}</h1>
      <LoginForm />
      <div className="mt-6">
        <SocialButtons />
      </div>
    </div>
  );
}
