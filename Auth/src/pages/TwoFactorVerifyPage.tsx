import React from 'react';

import { TwoFactorVerify } from '../components/twofactor/TwoFactorVerify.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function TwoFactorVerifyPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.twoFactorVerify.title')}</h1>
      <TwoFactorVerify />
    </div>
  );
}
