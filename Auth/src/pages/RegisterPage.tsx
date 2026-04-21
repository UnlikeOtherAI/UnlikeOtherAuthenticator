import React, { useEffect } from 'react';

import { RegisterForm } from '../components/form/RegisterForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isRegistrationAllowed } from '../utils/auth-config.js';

export function RegisterPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config, setView } = usePopup();
  const registrationAllowed = isRegistrationAllowed(config);

  useEffect(() => {
    if (!registrationAllowed) setView('login');
  }, [registrationAllowed, setView]);

  if (!registrationAllowed) {
    return <div />;
  }

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.register.title')}</h1>
      <RegisterForm />
      <div className="mt-6">
        <SocialButtons />
      </div>
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
