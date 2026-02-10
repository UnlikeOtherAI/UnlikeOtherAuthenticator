import React from 'react';

import { TwoFactorSetup } from '../components/twofactor/TwoFactorSetup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function TwoFactorSetupPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.twoFactorSetup.title')}</h1>
      <TwoFactorSetup />
    </div>
  );
}
