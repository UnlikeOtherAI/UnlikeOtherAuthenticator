import React, { useId } from 'react';

function fieldInputClasses(): string {
  return [
    'mt-1 w-full rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)]',
    'bg-[var(--uoa-color-surface)] px-3 py-2 text-[var(--uoa-color-text)]',
    'placeholder:text-[var(--uoa-color-muted)]',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
  ].join(' ');
}

export function TwoFactorInput(props: {
  label?: string;
  value: string;
  onChange: (next: string) => void;
  digits?: 6 | 8;
  disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  const { label = 'Verification code', digits = 6 } = props;

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder={digits === 8 ? '12345678' : '123456'}
        required
        disabled={props.disabled}
        maxLength={digits}
        className={fieldInputClasses()}
        value={props.value}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          const next = raw.replace(/[^0-9]/g, '').slice(0, digits);
          props.onChange(next);
        }}
      />
    </div>
  );
}

