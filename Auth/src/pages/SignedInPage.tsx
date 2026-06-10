import React, { useEffect } from 'react';

import { Button } from '../components/ui/Button.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';

/**
 * Terminal handoff view for native deep-link logins. The sign-in already succeeded and an
 * authorization code is bound to the custom-scheme `handoffTarget`. We launch that deep link
 * (which hands off to the OS app without unloading this tab) and tell the user they can close
 * the window, with a manual button as a fallback for browsers that suppress the auto-launch.
 */
export function SignedInPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const target = usePopup().handoffTarget;

  useEffect(() => {
    if (target && typeof window !== 'undefined') {
      window.location.href = target;
    }
  }, [target]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className={`text-balance ${classNames.title}`}>{t('auth.signedIn.title')}</h1>
      <p className="text-sm text-[var(--uoa-color-muted)]">{t('message.signedIn')}</p>
      {target ? (
        <Button type="button" onClick={() => window.location.assign(target)}>
          {t('action.openApp')}
        </Button>
      ) : null}
    </div>
  );
}
