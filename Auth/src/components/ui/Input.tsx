import React, { useId } from 'react';

const FIELD_INPUT_CLASS = [
  'mt-1 w-full rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)]',
  'bg-[var(--uoa-color-surface)] px-3 py-2 text-[var(--uoa-color-text)]',
  'placeholder:text-[var(--uoa-color-muted)]',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
  'disabled:cursor-not-allowed disabled:opacity-60',
].join(' ');

export function fieldInputClassName(extra?: string): string {
  return extra ? `${FIELD_INPUT_CLASS} ${extra}` : FIELD_INPUT_CLASS;
}

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  id?: string;
  label?: string;
  error?: string | null;
};

export function Input(props: InputProps): React.JSX.Element {
  const autoId = useId();
  const { id, label, error, className, ...rest } = props;
  const inputId = id ?? autoId;

  return (
    <div>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={fieldInputClassName(className)}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error && (
        <p className="mt-1 text-sm text-[var(--uoa-color-danger)]">{error}</p>
      )}
    </div>
  );
}
