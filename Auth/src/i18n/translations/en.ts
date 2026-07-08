export const en = {
  'auth.login.title': 'Sign in',
  'auth.register.title': 'Create your account',
  'auth.resetPassword.title': 'Reset your password',
  'auth.setPassword.title': 'Set your password',
  'auth.accessRequested.title': 'Access request submitted',
  'auth.signedIn.title': 'You’re signed in',
  'auth.twoFactorVerify.title': 'Verify two-factor code',
  'auth.twoFactorSetup.title': 'Set up two-factor authentication',
  'auth.codeEntry.title': 'Enter your code',
  'auth.workspaceChooser.title': 'Choose a workspace',

  'form.email.label': 'Email',
  'form.password.label': 'Password',
  'form.newPassword.label': 'New password',
  'form.confirmPassword.label': 'Confirm password',

  'form.rememberMe.label': 'Remember me',
  'form.password.show': 'Show',
  'form.password.hide': 'Hide',
  'form.password.requirement.minLength': 'Be at least 8 characters',
  'form.error.generic': 'Request failed. Please try again.',
  'form.login.submit': 'Sign in',
  'form.login.error': 'Invalid email or password.',
  'form.register.submit': 'Continue',
  'form.resetPassword.submit': 'Send reset instructions',
  'form.setPassword.submit': 'Set password and continue',
  'form.setPassword.error': 'Something went wrong. Please try again.',
  'form.setPassword.tooShort': 'Password must be at least 8 characters.',
  'form.setPassword.linkInvalid':
    'This link is invalid or has expired. Request a new one and try again.',
  'form.setPassword.mismatch': 'Passwords do not match.',
  'form.setPassword.success': 'Password reset successful. You can now sign in.',

  // Used by registration and reset-password flows; must remain generic.
  'message.instructionsSent': 'We sent instructions to your email',
  'message.emailAlreadyRegistered':
    'This email is already registered. Sign in or reset your password to continue.',
  'message.accessRequested':
    'Your request has been sent to the team administrators. You can close this window and wait for approval.',
  'message.signedIn': 'Return to the app to finish signing in. You can close this window.',
  'action.openApp': 'Open the app',

  // Navigation links between auth views.
  'nav.forgotPassword': 'Forgot your password?',
  'nav.createAccount': 'Create an account',
  'nav.backToLogin': 'Back to sign in',
  'nav.resetPassword': 'Reset password',
  'nav.emailMeCode': 'Email me a sign-in code',

  // Phase 3c: email-code entry (design §11.2).
  'codeEntry.instructions': 'We sent a code to {email}',
  'codeEntry.submit': 'Verify',
  'codeEntry.resend': 'Resend code',
  'codeEntry.resend.sent': 'We sent a new code to your email',
  'codeEntry.error': 'Could not verify the code. Please try again.',

  // Phase 3c: workspace chooser (design §11.2 — copy names the workspace, not the product).
  'workspaceChooser.subtitle': 'Your workspaces for {email}',
  'workspaceChooser.autoSkip': 'Signing you in…',
  'workspace.role.owner': 'Owner',
  'workspace.role.admin': 'Admin',
  'workspace.invite.title': 'You’ve been invited to {teamName}',
  'workspace.invite.invitedBy': 'Invited by {invitedBy}',
  'workspace.invite.accept': 'Accept',
  'workspace.invite.decline': 'Decline',
  'workspace.createOrg.title': 'Create a new workspace',
  'workspace.createOrg.subtitle': 'Start a brand new workspace',

  'twoFactor.setup.instructions':
    'Scan this QR code with an authenticator app, then enter the 6-digit code to verify setup.',
  'twoFactor.setup.loading': 'Loading QR code...',
  'twoFactor.setup.manual': 'Manual setup key:',
  'twoFactor.setup.error': 'Could not set up two-factor authentication. Please try again.',
  'twoFactor.setup.submit': 'Enable 2FA',
  'twoFactor.setup.success': 'Two-factor authentication is enabled',
  'twoFactor.qr.alt': 'Two-factor setup QR code',
  'twoFactor.qr.placeholder': 'QR code will appear here',
  'twoFactor.code.label': 'Verification code',

  'twoFactor.verify.instructions':
    'Enter the 6-digit code from your authenticator app to finish signing in.',
  'twoFactor.verify.error': 'Could not verify the code. Please try again.',
  'twoFactor.verify.submit': 'Verify',
  'twoFactor.verify.success': 'Verification successful',

  'social.divider': 'or',
  'social.continueWith': 'Continue with',
} as const;

export type TranslationKey = keyof typeof en;
export type Translations = Record<TranslationKey, string>;
