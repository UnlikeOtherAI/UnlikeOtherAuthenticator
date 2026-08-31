import React from 'react';

import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

export function InviteAcceptedPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.inviteAccepted.title')}</h1>
      <p className="mt-4 text-[var(--uoa-color-muted)]">{t('message.inviteAccepted')}</p>
    </div>
  );
}
