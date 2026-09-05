export const en = {
  'auth.login.title': 'Sign in',
  'auth.register.title': 'Create your account',
  'auth.resetPassword.title': 'Reset your password',
  'auth.setPassword.title': 'Set your password',
  'auth.invite.title': 'Create your account',
  'auth.inviteAccepted.title': 'Invitation accepted',
  'auth.accessRequested.title': 'Access request submitted',
  'auth.signedIn.title': 'You’re signed in',
  'auth.twoFactorVerify.title': 'Verify two-factor code',
  'auth.twoFactorSetup.title': 'Set up two-factor authentication',
  'auth.codeEntry.title': 'Enter your code',
  'auth.teamChooser.title': 'Choose a team',
  'auth.signatures.title': 'Review and sign agreements',

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
  'form.invite.submit': 'Create account',
  'form.invite.error': 'This invitation is invalid or has expired. Ask for a new invitation.',

  // Used by registration and reset-password flows; must remain generic.
  'message.instructionsSent': 'We sent instructions to your email',
  'message.emailAlreadyRegistered':
    'This email is already registered. Sign in or reset your password to continue.',
  'message.accessRequested':
    'Your request has been sent to the team administrators. You can close this window and wait for approval.',
  'message.signedIn': 'Return to the app to finish signing in. You can close this window.',
  'message.inviteAccepted': 'Your account has been created and you have joined the team. You can close this window.',
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

  // Phase 3c: team chooser (design §11.2 — copy names the team, not the product).
  'teamChooser.subtitle': 'Your teams for {email}',
  'teamChooser.autoSkip': 'Signing you in…',
  'team.role.owner': 'Owner',
  'team.role.admin': 'Admin',
  'team.invite.title': 'You’ve been invited to {teamName}',
  'team.invite.invitedBy': 'Invited by {invitedBy}',
  'team.invite.accept': 'Accept',
  'team.invite.decline': 'Decline',
  'team.createOrg.title': 'Create a new team',
  'team.createOrg.subtitle': 'Start a brand new team',
  'team.createOrg.nameLabel': 'Team name',
  'team.createOrg.submit': 'Create team',
  'team.createOrg.cancel': 'Cancel',
  'team.address.label': 'Team address',
  'team.address.hint': 'This becomes the web address for the team. You can change it later.',
  'team.address.checking': 'Checking availability…',
  'team.address.available': 'Available',
  'team.address.error.taken': 'That address is already in use.',
  'team.address.error.too_short': 'Use at least 2 characters.',
  'team.address.error.too_long': 'Use at most 63 characters.',
  'team.address.error.charset':
    'Use only letters, numbers and hyphens, starting and ending with a letter or number.',
  'team.address.error.double_hyphen': 'Two hyphens in a row are not allowed.',
  'team.address.error.all_digits': 'An address cannot be only numbers.',
  'team.address.error.reserved': 'That address is reserved.',
  'team.createDialog.open': 'Create team',
  'team.createDialog.title': 'Create a team',
  'team.createDialog.subtitle': 'Choose where it belongs and who can find it.',
  'team.createDialog.destinationLabel': 'Organisation',
  'team.createDialog.newOrganisation': 'Create a new organisation',
  'team.createDialog.newOrganisationDescription':
    'This creates an organisation and its first team.',
  'team.createDialog.existingOrganisationDescription':
    'This adds a team to the selected organisation.',
  'team.createDialog.visibilityLabel': 'Visibility',
  'team.createDialog.visibility.private': 'Private',
  'team.createDialog.visibility.privateDescription':
    'Only people you invite can discover this team.',
  'team.createDialog.visibility.inviteOnly': 'Invite only',
  'team.createDialog.visibility.inviteOnlyDescription':
    'People need an invite before they can join this team.',
  'team.createDialog.visibility.openToOrganisation': 'Open to organisation',
  'team.createDialog.visibility.openToOrganisationDescription':
    'Active members of the organisation can join this team themselves.',
  'team.createDialog.submit': 'Create team',
  'team.createDialog.cancel': 'Cancel',

  'notice.sessionExpired': 'Your sign-in took too long and expired. Please sign in again.',
  'team.orgSection.addTeam': 'Add a team to {org}',
  'team.createTeam.nameLabel': 'Team name',
  'team.createTeam.submit': 'Create',
  'team.createTeam.cancel': 'Cancel',

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

  'signatures.loading': 'Loading your agreements…',
  'signatures.restart':
    'This signing session is no longer available. Return to the app and restart sign-in.',
  'signatures.intro':
    '{domain} requires the following current agreements before sign-in can finish.',
  'signatures.expires': 'This secure signing session expires at {time}.',
  'signatures.sourceError': 'The verified source document could not be loaded. Please try again.',
  'signatures.receiptError': 'The verified receipt could not be downloaded. Please try again.',
  'signatures.signError': 'The agreement could not be signed. Check your confirmation and try again.',
  'signatures.signed': 'Agreement signed. Your authenticated evidence receipt is ready below.',
  'signatures.version': 'Version {version}',
  'signatures.downloadSource': 'Download source PDF',
  'signatures.loadingDocument': 'Loading verified PDF…',
  'signatures.viewerTitle': 'PDF viewer for {title}',
  'signatures.confirmTitle': 'Acceptance statement',
  'signatures.confirmCheckbox': 'I explicitly confirm the acceptance statement shown above.',
  'signatures.fullName': 'Your full name',
  'signatures.nameAssertion':
    'Your typed name is recorded as your assertion. It is not independent identity verification.',
  'signatures.evidenceNotice':
    'UOA records authenticated agreement evidence and verifies its integrity. This is not notarisation, a qualified electronic signature, or legal advice.',
  'signatures.signing': 'Signing…',
  'signatures.signContinue': 'Sign and continue',
  'signatures.completeTitle': 'All current agreements are signed',
  'signatures.completeBody':
    'Download any receipts you need, then finish sign-in. Requirements are checked once more before access is issued.',
  'signatures.receiptsTitle': 'Evidence receipts',
  'signatures.verificationReference': 'Verification reference',
  'signatures.revoked': 'This signature has been revoked.',
  'signatures.downloading': 'Downloading…',
  'signatures.downloadReceipt': 'Download receipt',
  'signatures.finishing': 'Finishing…',
  'signatures.finish': 'Finish sign-in',
} as const;

export type TranslationKey = keyof typeof en;
export type Translations = Record<TranslationKey, string>;
