import React from 'react';

import { PopupProvider, usePopup } from '../../hooks/use-popup.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { TwoFactorVerifyPage } from '../../pages/TwoFactorVerifyPage.js';
import { AuthLayout } from './AuthLayout.js';

function PopupContent(): React.JSX.Element {
  const popup = usePopup();

  // When the social callback flow requires 2FA, the server redirects back to /auth
  // with a `twofa_token` so the popup can render the verification screen.
  if (popup.twoFaToken) {
    return <TwoFactorVerifyPage />;
  }

  // Default entry: login screen (registration / reset flows are navigated in later tasks).
  return <LoginPage />;
}

export function PopupContainer(props: {
  configUrl: string;
  initialSearch?: string;
}): React.JSX.Element {
  return (
    <PopupProvider configUrl={props.configUrl} initialSearch={props.initialSearch}>
      <AuthLayout>
        <PopupContent />
      </AuthLayout>
    </PopupProvider>
  );
}

