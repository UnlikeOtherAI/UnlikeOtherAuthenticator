import React, { useEffect } from 'react';

import { LoginForm } from '../components/form/LoginForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { useTheme } from '../hooks/use-theme.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isEmailPasswordEnabled } from '../utils/auth-config.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config, notice, setNotice } = usePopup();
  const showEmailPassword = isEmailPasswordEnabled(config);

  // One-shot: landing here after an expired chooser bridge should say why, but the reason must not
  // outlive the visit — clearing on unmount keeps it off a later pass through this view.
  useEffect(() => () => setNotice(null), [setNotice]);

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.login.title')}</h1>
      {notice ? (
        <p
          role="status"
          className="mt-2 rounded-[var(--uoa-radius-input)] bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-muted)]"
        >
          {t(notice)}
        </p>
      ) : null}
      {showEmailPassword ? <LoginForm /> : null}
      <div className="mt-6">
        <SocialButtons showDivider={showEmailPassword} />
      </div>
    </div>
  );
}
