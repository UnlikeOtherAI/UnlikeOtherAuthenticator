import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';

function fieldInputClasses(): string {
  return [
    'mt-1 w-full rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)]',
    'bg-[var(--uoa-color-surface)] px-3 py-2 text-[var(--uoa-color-text)]',
    'placeholder:text-[var(--uoa-color-muted)]',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--uoa-color-primary)]',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--uoa-color-bg)]',
  ].join(' ');
}

export function RegisterForm(): React.JSX.Element {
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  return (
    <form
      className="mt-6 flex flex-col gap-4"
      onSubmit={(e) => {
        // Template only; API wiring is handled in a later task.
        // Always show the same message to avoid account-existence hints.
        e.preventDefault();
        setSubmitted(true);
      }}
    >
      <div>
        <label htmlFor={emailId} className="text-sm font-medium">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          className={fieldInputClasses()}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </div>

      <div className="mt-2">
        <Button variant="primary" type="submit">
          Continue
        </Button>
      </div>

      {submitted ? (
        <p
          role="status"
          className={[
            'rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
            'bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]',
          ].join(' ')}
        >
          We sent instructions to your email
        </p>
      ) : null}
    </form>
  );
}

