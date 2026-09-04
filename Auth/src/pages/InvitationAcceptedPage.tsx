import React from 'react';

import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

/** Terminal confirmation for an email invitation accepted through social sign-in. */
export function InvitationAcceptedPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.invitationAccepted.title')}</h1>
      <p className="text-sm text-[var(--uoa-color-muted)]">{t('message.invitationAccepted')}</p>
    </div>
  );
}
