import React from 'react';

import { useTranslation } from '../../i18n/use-translation.js';
import { checkPasswordPolicy } from '../../utils/password-policy.js';

/**
 * Live checklist showing which password requirements the current value meets.
 *
 * Rendered under the new-password field on set/reset so the user always knows up front whether
 * their password is acceptable, instead of finding out via a server error (HUGO-147).
 */
export function PasswordRequirements({ password }: { password: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { requirements } = checkPasswordPolicy(password);

  return (
    <ul className="mt-1 flex flex-col gap-1 text-xs" aria-live="polite">
      {requirements.map((r) => (
        <li
          key={r.key}
          className={
            r.met ? 'text-[var(--uoa-color-text)]' : 'text-[var(--uoa-color-muted)]'
          }
        >
          <span aria-hidden="true" className="mr-1">
            {r.met ? '✓' : '○'}
          </span>
          {t(r.label)}
        </li>
      ))}
    </ul>
  );
}
