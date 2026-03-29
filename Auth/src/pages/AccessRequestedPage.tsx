import React from 'react';

import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function AccessRequestedPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.accessRequested.title')}</h1>
      <p className="text-sm text-[var(--uoa-color-muted)]">
        {t('message.accessRequested')}
      </p>
    </div>
  );
}
