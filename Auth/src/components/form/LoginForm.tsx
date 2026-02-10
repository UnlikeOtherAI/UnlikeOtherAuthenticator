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

export function LoginForm(): React.JSX.Element {
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="mt-6 flex flex-col gap-4"
      onSubmit={(e) => {
        // Template only; API wiring is handled in a later task.
        e.preventDefault();
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

      <div>
        <label htmlFor={passwordId} className="text-sm font-medium">
          Password
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={fieldInputClasses()}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
      </div>

      <div className="mt-2">
        <Button variant="primary" type="submit">
          Sign in
        </Button>
      </div>
    </form>
  );
}

