import React from 'react';

import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import { resolveProductName, selectAllowedContinueUrl } from '../utils/continue-url.js';

export function InviteAcceptedPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const { config, redirectUrl } = usePopup();

  // F5: an invitee who registered from a mailbox has no product tab to go back to. When the
  // invitation carried an allow-listed redirect URL, name the product and offer the way in;
  // without one this page is exactly what it was — a close-the-window confirmation.
  const continueUrl = selectAllowedContinueUrl(config, redirectUrl);
  const productName = resolveProductName(config, t('message.inviteAccepted.product'));

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.inviteAccepted.title')}</h1>
      <p className="mt-4 text-[var(--uoa-color-muted)]">
        {continueUrl ? t('message.inviteAccepted.joined') : t('message.inviteAccepted')}
      </p>
      {continueUrl ? (
        <a
          href={continueUrl}
          className="mt-6 inline-flex w-full items-center justify-center rounded-[var(--uoa-radius-button)] bg-[var(--uoa-color-primary)] px-4 py-2 text-sm font-semibold text-[var(--uoa-color-primary-text)] no-underline"
        >
          {t('message.inviteAccepted.continue', { product: productName })}
        </a>
      ) : null}
    </div>
  );
}
