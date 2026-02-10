import React, { useState } from 'react';

import { TwoFactorInput } from '../form/TwoFactorInput.js';
import { Button } from '../ui/Button.js';
import { useTranslation } from '../../i18n/use-translation.js';

export function TwoFactorVerify(): React.JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm text-[var(--uoa-color-muted)]">
        {t('twoFactor.verify.instructions')}
      </p>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          // Template only; login verification API wiring is handled in a later task.
          e.preventDefault();
          setDone(true);
        }}
      >
        <TwoFactorInput value={code} onChange={setCode} digits={6} disabled={done} />

        <div className="mt-2">
          <Button variant="primary" type="submit" disabled={done || code.length !== 6}>
            {t('twoFactor.verify.submit')}
          </Button>
        </div>

        {done ? (
          <p
            role="status"
            className={[
              'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
              'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
            ].join(' ')}
          >
            {t('twoFactor.verify.success')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
