import React from 'react';

import { LoginForm } from '../components/form/LoginForm.js';
import { useTheme } from '../hooks/use-theme.js';

export function LoginPage(): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>Sign in</h1>
      <LoginForm />
    </div>
  );
}

