import React from 'react';

import { PopupProvider, usePopup } from '../../hooks/use-popup.js';
import { AccessRequestedPage } from '../../pages/AccessRequestedPage.js';
import { CodeEntryPage } from '../../pages/CodeEntryPage.js';
import { LoginPage } from '../../pages/LoginPage.js';
import { RegisterPage } from '../../pages/RegisterPage.js';
import { ResetPasswordPage } from '../../pages/ResetPasswordPage.js';
import { SetPasswordPage } from '../../pages/SetPasswordPage.js';
import { SignedInPage } from '../../pages/SignedInPage.js';
import { SigningPage } from '../../pages/SigningPage.js';
import { TwoFactorSetupPage } from '../../pages/TwoFactorSetupPage.js';
import { TwoFactorVerifyPage } from '../../pages/TwoFactorVerifyPage.js';
import { WorkspaceChooserPage } from '../../pages/WorkspaceChooserPage.js';
import { AuthLayout } from './AuthLayout.js';

function PopupContent(): React.JSX.Element {
  const popup = usePopup();

  // Required 2FA enrollment can be reached from password login or social callback.
  if (popup.twoFactorSetup) {
    return <TwoFactorSetupPage />;
  }

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
    case 'access-requested':
      return <AccessRequestedPage />;
    case 'signed-in':
      return <SignedInPage />;
    case 'signatures':
      return <SigningPage />;
    case 'code-entry':
      return <CodeEntryPage />;
    case 'workspace-chooser':
      return <WorkspaceChooserPage />;
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
