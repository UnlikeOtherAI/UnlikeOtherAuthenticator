export const en = {
  'auth.login.title': 'Sign in',
  'auth.register.title': 'Create your account',
  'auth.resetPassword.title': 'Reset your password',
  'auth.setPassword.title': 'Set your password',
  'auth.twoFactorVerify.title': 'Verify two-factor code',
  'auth.twoFactorSetup.title': 'Set up two-factor authentication',

  'form.email.label': 'Email',
  'form.password.label': 'Password',
  'form.newPassword.label': 'New password',
  'form.confirmPassword.label': 'Confirm password',

  'form.login.submit': 'Sign in',
  'form.login.error': 'Invalid email or password.',
  'form.register.submit': 'Continue',
  'form.resetPassword.submit': 'Send reset instructions',
  'form.setPassword.submit': 'Set password and continue',
  'form.setPassword.error': 'Something went wrong. The link may have expired.',
  'form.setPassword.mismatch': 'Passwords do not match.',
  'form.setPassword.success': 'Password reset successful. You can now sign in.',

  // Used by registration and reset-password flows; must remain generic.
  'message.instructionsSent': 'We sent instructions to your email',

  // Navigation links between auth views.
  'nav.forgotPassword': 'Forgot your password?',
  'nav.createAccount': 'Create an account',
  'nav.backToLogin': 'Back to sign in',

  'twoFactor.setup.instructions':
    'Scan this QR code with an authenticator app, then enter the 6-digit code to verify setup.',
  'twoFactor.setup.submit': 'Enable 2FA',
  'twoFactor.setup.success': 'Two-factor authentication is enabled',

  'twoFactor.verify.instructions':
    'Enter the 6-digit code from your authenticator app to finish signing in.',
  'twoFactor.verify.submit': 'Verify',
  'twoFactor.verify.success': 'Verification successful',

  'social.divider': 'or',
  'social.continueWith': 'Continue with',
} as const;

export type TranslationKey = keyof typeof en;
export type Translations = Record<TranslationKey, string>;

