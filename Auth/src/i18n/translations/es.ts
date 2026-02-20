import type { Translations } from './en.js';

export const es = {
  'auth.login.title': 'Iniciar sesion',
  'auth.register.title': 'Crea tu cuenta',
  'auth.resetPassword.title': 'Restablecer tu contrasena',
  'auth.twoFactorVerify.title': 'Verificar codigo de dos factores',
  'auth.twoFactorSetup.title': 'Configurar autenticacion de dos factores',

  'form.email.label': 'Correo electronico',
  'form.password.label': 'Contrasena',

  'form.login.submit': 'Iniciar sesion',
  'form.register.submit': 'Continuar',
  'form.resetPassword.submit': 'Enviar instrucciones de restablecimiento',

  'message.instructionsSent': 'Hemos enviado instrucciones a tu correo electronico',

  'twoFactor.setup.instructions':
    'Escanea este codigo QR con una app autenticadora y luego ingresa el codigo de 6 digitos para verificar la configuracion.',
  'twoFactor.setup.submit': 'Activar 2FA',
  'twoFactor.setup.success': 'La autenticacion de dos factores esta habilitada',

  'twoFactor.verify.instructions':
    'Ingresa el codigo de 6 digitos de tu app autenticadora para terminar de iniciar sesion.',
  'twoFactor.verify.submit': 'Verificar',
  'twoFactor.verify.success': 'Verificacion exitosa',

  'social.divider': 'o',
  'social.continueWith': 'Continuar con',
} satisfies Translations;

