import React from 'react';

import { PopupProvider, usePopup } from '../../hooks/use-popup.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { RegisterPage } from '../../pages/RegisterPage.js';
import { ResetPasswordPage } from '../../pages/ResetPasswordPage.js';
import { SetPasswordPage } from '../../pages/SetPasswordPage.js';
import { TwoFactorVerifyPage } from '../../pages/TwoFactorVerifyPage.js';
import { AuthLayout } from './AuthLayout.js';

function PopupContent(): React.JSX.Element {
  const popup = usePopup();

  // When the social callback flow requires 2FA, the server redirects back to /auth
  // with a `twofa_token` so the popup can render the verification screen.
  if (popup.twoFaToken) {
    return <TwoFactorVerifyPage />;
  }

  switch (popup.view) {
    case 'register':
      return <RegisterPage />;
    case 'reset-password':
      return <ResetPasswordPage />;
    case 'set-password':
      return <SetPasswordPage />;
    default:
      return <LoginPage />;
  }
}

export function PopupContainer(props: {
  configUrl: string;
  config?: unknown;
  initialSearch?: string;
}): React.JSX.Element {
  return (
    <PopupProvider configUrl={props.configUrl} config={props.config} initialSearch={props.initialSearch}>
      <AuthLayout>
        <PopupContent />
      </AuthLayout>
    </PopupProvider>
  );
}
