import type { Translations } from './en.js';

export const cs = {
  'auth.login.title': 'Přihlášení',
  'auth.register.title': 'Vytvoření účtu',
  'auth.resetPassword.title': 'Obnovení hesla',
  'auth.setPassword.title': 'Nastavení hesla',
  'auth.accessRequested.title': 'Žádost o přístup byla odeslána',
  'auth.signedIn.title': 'Jste přihlášeni',
  'auth.twoFactorVerify.title': 'Ověření dvoufaktorovým kódem',
  'auth.twoFactorSetup.title': 'Nastavení dvoufaktorového ověření',

  'form.email.label': 'E-mail',
  'form.password.label': 'Heslo',
  'form.newPassword.label': 'Nové heslo',
  'form.confirmPassword.label': 'Potvrzení hesla',

  'form.rememberMe.label': 'Zapamatovat si mě',
  'form.password.show': 'Zobrazit',
  'form.password.hide': 'Skrýt',
  'form.password.requirement.minLength': 'Alespoň 8 znaků',
  'form.error.generic': 'Požadavek se nezdařil. Zkuste to prosím znovu.',
  'form.login.submit': 'Přihlásit se',
  'form.login.error': 'Neplatný e-mail nebo heslo.',
  'form.register.submit': 'Pokračovat',
  'form.resetPassword.submit': 'Odeslat pokyny k obnovení',
  'form.setPassword.submit': 'Nastavit heslo a pokračovat',
  'form.setPassword.error': 'Něco se nepodařilo. Zkuste to prosím znovu.',
  'form.setPassword.tooShort': 'Heslo musí mít alespoň 8 znaků.',
  'form.setPassword.linkInvalid':
    'Tento odkaz je neplatný nebo jeho platnost vypršela. Vyžádejte si nový a zkuste to znovu.',
  'form.setPassword.mismatch': 'Hesla se neshodují.',
  'form.setPassword.success': 'Heslo bylo úspěšně obnoveno. Nyní se můžete přihlásit.',

  'message.instructionsSent': 'Poslali jsme Vám pokyny na e-mail',
  'message.emailAlreadyRegistered':
    'Tento e-mail už je zaregistrovaný. Pokračujte prosím přihlášením nebo obnovením hesla.',
  'message.accessRequested':
    'Vaše žádost byla odeslána správcům týmu. Toto okno můžete zavřít a počkat na schválení.',
  'message.signedIn': 'Vraťte se do aplikace a dokončete přihlášení. Toto okno můžete zavřít.',
  'action.openApp': 'Otevřít aplikaci',

  'nav.forgotPassword': 'Zapomněli jste heslo?',
  'nav.createAccount': 'Vytvořit účet',
  'nav.backToLogin': 'Zpět na přihlášení',
  'nav.resetPassword': 'Obnovit heslo',

  'twoFactor.setup.instructions':
    'Naskenujte tento QR kód v ověřovací aplikaci a potom zadejte 6místný kód pro dokončení nastavení.',
  'twoFactor.setup.loading': 'Načítá se QR kód...',
  'twoFactor.setup.manual': 'Klíč pro ruční nastavení:',
  'twoFactor.setup.error': 'Dvoufaktorové ověření se nepodařilo nastavit. Zkuste to prosím znovu.',
  'twoFactor.setup.submit': 'Zapnout 2FA',
  'twoFactor.setup.success': 'Dvoufaktorové ověření je zapnuté',
  'twoFactor.qr.alt': 'QR kód pro nastavení dvoufaktorového ověření',
  'twoFactor.qr.placeholder': 'QR kód se zobrazí zde',
  'twoFactor.code.label': 'Ověřovací kód',

  'twoFactor.verify.instructions':
    'Zadejte 6místný kód z ověřovací aplikace a dokončete přihlášení.',
  'twoFactor.verify.error': 'Kód se nepodařilo ověřit. Zkuste to prosím znovu.',
  'twoFactor.verify.submit': 'Ověřit',
  'twoFactor.verify.success': 'Ověření bylo úspěšné',

  'social.divider': 'nebo',
  'social.continueWith': 'Pokračovat přes',
} satisfies Translations;
