import React from 'react';

export function Switch(props: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}): React.JSX.Element {
  return (
    <label htmlFor={props.id} className="inline-flex cursor-pointer items-center gap-2">
      <button
        id={props.id}
        type="button"
        role="switch"
        aria-checked={props.checked}
        onClick={() => props.onChange(!props.checked)}
        className={[
          'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
          props.checked
            ? 'bg-[var(--uoa-color-primary)]'
            : 'bg-[var(--uoa-color-border)]',
        ].join(' ')}
      >
        <span
          className={[
            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200',
            props.checked ? 'translate-x-4' : 'translate-x-0',
          ].join(' ')}
        />
      </button>
      {props.label && <span className="text-sm text-[var(--uoa-color-text)]">{props.label}</span>}
    </label>
  );
}
