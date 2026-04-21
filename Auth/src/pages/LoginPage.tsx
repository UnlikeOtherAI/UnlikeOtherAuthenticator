import React from 'react';

import { LoginForm } from '../components/form/LoginForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { useTheme } from '../hooks/use-theme.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isEmailPasswordEnabled } from '../utils/auth-config.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config } = usePopup();
  const showEmailPassword = isEmailPasswordEnabled(config);

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.login.title')}</h1>
      {showEmailPassword ? <LoginForm /> : null}
      <div className="mt-6">
        <SocialButtons showDivider={showEmailPassword} />
      </div>
    </div>
  );
}
