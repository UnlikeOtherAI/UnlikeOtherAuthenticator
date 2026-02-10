import React from 'react';

import { ResetPasswordForm } from '../components/form/ResetPasswordForm.js';
import { useTheme } from '../hooks/use-theme.js';

export function ResetPasswordPage(): React.JSX.Element {
  const { classNames } = useTheme();

  return (
    <div>
      <h1 className={`text-balance ${classNames.title}`}>Reset your password</h1>
      <ResetPasswordForm />
    </div>
  );
}

