import React from 'react';

import { RegisterForm } from '../components/form/RegisterForm.js';
import { useTheme } from '../hooks/use-theme.js';

export function RegisterPage(): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>Create your account</h1>
      <RegisterForm />
    </div>
  );
}

