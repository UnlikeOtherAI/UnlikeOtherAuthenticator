import React from 'react';

import { InviteRegistrationForm } from '../components/form/InviteRegistrationForm.js';
import { SocialButtons } from '../components/form/SocialButtons.js';
import { Input } from '../components/ui/Input.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { isEmailPasswordEnabled } from '../utils/auth-config.js';
import { usePopup } from '../hooks/use-popup.js';

export function InviteRegistrationPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config, inviteEmail } = usePopup();
  const showEmailPassword = isEmailPasswordEnabled(config);

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.invite.title')}</h1>
      <div className="mt-6">
        <Input
          name="email"
          type="email"
          autoComplete="email"
          label={t('form.email.label')}
          value={inviteEmail ?? ''}
          readOnly
          aria-readonly="true"
        />
      </div>
      {showEmailPassword ? <InviteRegistrationForm /> : null}
      <div className="mt-6">
        <SocialButtons showDivider={showEmailPassword} />
      </div>
    </div>
  );
}
