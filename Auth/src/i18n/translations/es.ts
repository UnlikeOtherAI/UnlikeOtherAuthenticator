import type { Translations } from './en.js';

export const es = {
  'auth.login.title': 'Iniciar sesion',
  'auth.register.title': 'Crea tu cuenta',
  'auth.resetPassword.title': 'Restablecer tu contrasena',
  'auth.setPassword.title': 'Establece tu contrasena',
  'auth.accessRequested.title': 'Solicitud de acceso enviada',
  'auth.signedIn.title': 'Sesion iniciada',
  'auth.twoFactorVerify.title': 'Verificar codigo de dos factores',
  'auth.twoFactorSetup.title': 'Configurar autenticacion de dos factores',

  'form.email.label': 'Correo electronico',
  'form.password.label': 'Contrasena',
  'form.newPassword.label': 'Nueva contrasena',
  'form.confirmPassword.label': 'Confirmar contrasena',

  'form.rememberMe.label': 'Recordarme',
  'form.password.show': 'Mostrar',
  'form.password.hide': 'Ocultar',
  'form.password.requirement.minLength': 'Tener al menos 8 caracteres',
  'form.error.generic': 'La solicitud fallo. Intentalo de nuevo.',
  'form.login.submit': 'Iniciar sesion',
  'form.login.error': 'Correo electronico o contrasena invalidos.',
  'form.register.submit': 'Continuar',
  'form.resetPassword.submit': 'Enviar instrucciones de restablecimiento',
  'form.setPassword.submit': 'Establecer contrasena y continuar',
  'form.setPassword.error': 'Algo salio mal. Intentalo de nuevo.',
  'form.setPassword.tooShort': 'La contrasena debe tener al menos 8 caracteres.',
  'form.setPassword.linkInvalid':
    'Este enlace es invalido o ha expirado. Solicita uno nuevo e intentalo de nuevo.',
  'form.setPassword.mismatch': 'Las contrasenas no coinciden.',
  'form.setPassword.success': 'Contrasena restablecida correctamente. Ya puedes iniciar sesion.',

  'message.instructionsSent': 'Hemos enviado instrucciones a tu correo electronico',
  'message.accessRequested':
    'Tu solicitud se ha enviado a los administradores del equipo. Puedes cerrar esta ventana y esperar su aprobacion.',
  'message.signedIn': 'Vuelve a la aplicacion para terminar de iniciar sesion. Puedes cerrar esta ventana.',
  'action.openApp': 'Abrir la aplicacion',

  'nav.forgotPassword': 'Olvidaste tu contrasena?',
  'nav.createAccount': 'Crear una cuenta',
  'nav.backToLogin': 'Volver a iniciar sesion',

  'twoFactor.setup.instructions':
    'Escanea este codigo QR con una app autenticadora y luego ingresa el codigo de 6 digitos para verificar la configuracion.',
  'twoFactor.setup.loading': 'Cargando codigo QR...',
  'twoFactor.setup.manual': 'Clave de configuracion manual:',
  'twoFactor.setup.error': 'No se pudo configurar la autenticacion de dos factores. Intentalo de nuevo.',
  'twoFactor.setup.submit': 'Activar 2FA',
  'twoFactor.setup.success': 'La autenticacion de dos factores esta habilitada',
  'twoFactor.qr.alt': 'Codigo QR de configuracion de dos factores',
  'twoFactor.qr.placeholder': 'El codigo QR aparecera aqui',
  'twoFactor.code.label': 'Codigo de verificacion',

  'twoFactor.verify.instructions':
    'Ingresa el codigo de 6 digitos de tu app autenticadora para terminar de iniciar sesion.',
  'twoFactor.verify.error': 'No se pudo verificar el codigo. Intentalo de nuevo.',
  'twoFactor.verify.submit': 'Verificar',
  'twoFactor.verify.success': 'Verificacion exitosa',

  'social.divider': 'o',
  'social.continueWith': 'Continuar con',
} satisfies Translations;
