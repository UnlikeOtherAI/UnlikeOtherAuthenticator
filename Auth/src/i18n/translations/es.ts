import type { Translations } from './en.js';

export const es = {
  'auth.login.title': 'Iniciar sesion',
  'auth.register.title': 'Crea tu cuenta',
  'auth.resetPassword.title': 'Restablecer tu contrasena',
  'auth.setPassword.title': 'Establece tu contrasena',
  'auth.accessRequested.title': 'Solicitud de acceso enviada',
  'auth.twoFactorVerify.title': 'Verificar codigo de dos factores',
  'auth.twoFactorSetup.title': 'Configurar autenticacion de dos factores',

  'form.email.label': 'Correo electronico',
  'form.password.label': 'Contrasena',
  'form.newPassword.label': 'Nueva contrasena',
  'form.confirmPassword.label': 'Confirmar contrasena',

  'form.rememberMe.label': 'Recordarme',
  'form.login.submit': 'Iniciar sesion',
  'form.login.error': 'Correo electronico o contrasena invalidos.',
  'form.register.submit': 'Continuar',
  'form.resetPassword.submit': 'Enviar instrucciones de restablecimiento',
  'form.setPassword.submit': 'Establecer contrasena y continuar',
  'form.setPassword.error': 'Algo salio mal. El enlace puede haber expirado.',
  'form.setPassword.mismatch': 'Las contrasenas no coinciden.',
  'form.setPassword.success': 'Contrasena restablecida correctamente. Ya puedes iniciar sesion.',

  'message.instructionsSent': 'Hemos enviado instrucciones a tu correo electronico',
  'message.accessRequested':
    'Tu solicitud se ha enviado a los administradores del equipo. Puedes cerrar esta ventana y esperar su aprobacion.',

  'nav.forgotPassword': 'Olvidaste tu contrasena?',
  'nav.createAccount': 'Crear una cuenta',
  'nav.backToLogin': 'Volver a iniciar sesion',

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
