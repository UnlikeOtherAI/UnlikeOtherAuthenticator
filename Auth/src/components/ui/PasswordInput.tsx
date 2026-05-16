import React, { useId, useState } from 'react';

import { fieldInputClassName } from './Input.js';

export type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'id' | 'type'
> & {
  id?: string;
  label?: string;
  error?: string | null;
  showToggleLabel?: string;
  hideToggleLabel?: string;
};

export function PasswordInput(props: PasswordInputProps): React.JSX.Element {
  const autoId = useId();
  const {
    id,
    label,
    error,
    className,
    showToggleLabel = 'Show',
    hideToggleLabel = 'Hide',
    ...rest
  } = props;
  const inputId = id ?? autoId;
  const [visible, setVisible] = useState(false);

  return (
    <div>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          type={visible ? 'text' : 'password'}
          className={fieldInputClassName(`pr-16 ${className ?? ''}`.trim())}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? hideToggleLabel : showToggleLabel}
          className={[
            'absolute inset-y-0 right-2 my-1 flex items-center rounded px-2 text-xs font-medium',
            'text-[var(--uoa-color-primary)] hover:underline',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
          ].join(' ')}
        >
          {visible ? hideToggleLabel : showToggleLabel}
        </button>
      </div>
      {error && (
        <p className="mt-1 text-sm text-[var(--uoa-color-danger)]">{error}</p>
      )}
    </div>
  );
}
