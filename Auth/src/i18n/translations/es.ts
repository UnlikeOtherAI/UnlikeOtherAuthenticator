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
  'auth.codeEntry.title': 'Ingresa tu codigo',
  'auth.workspaceChooser.title': 'Elige un espacio de trabajo',
  'auth.signatures.title': 'Revisa y firma los acuerdos',

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
  'message.emailAlreadyRegistered':
    'Este correo electronico ya esta registrado. Inicia sesion o restablece tu contrasena para continuar.',
  'message.accessRequested':
    'Tu solicitud se ha enviado a los administradores del equipo. Puedes cerrar esta ventana y esperar su aprobacion.',
  'message.signedIn': 'Vuelve a la aplicacion para terminar de iniciar sesion. Puedes cerrar esta ventana.',
  'action.openApp': 'Abrir la aplicacion',

  'nav.forgotPassword': 'Olvidaste tu contrasena?',
  'nav.createAccount': 'Crear una cuenta',
  'nav.backToLogin': 'Volver a iniciar sesion',
  'nav.resetPassword': 'Restablecer contrasena',
  'nav.emailMeCode': 'Enviarme un codigo de acceso',

  'codeEntry.instructions': 'Enviamos un codigo a {email}',
  'codeEntry.submit': 'Verificar',
  'codeEntry.resend': 'Reenviar codigo',
  'codeEntry.resend.sent': 'Enviamos un nuevo codigo a tu correo electronico',
  'codeEntry.error': 'No se pudo verificar el codigo. Intentalo de nuevo.',

  'workspaceChooser.subtitle': 'Tus espacios de trabajo para {email}',
  'workspaceChooser.autoSkip': 'Iniciando sesion...',
  'workspace.role.owner': 'Propietario',
  'workspace.role.admin': 'Administrador',
  'workspace.invite.title': 'Te invitaron a {teamName}',
  'workspace.invite.invitedBy': 'Invitado por {invitedBy}',
  'workspace.invite.accept': 'Aceptar',
  'workspace.invite.decline': 'Rechazar',
  'workspace.createOrg.title': 'Crear un nuevo espacio de trabajo',
  'workspace.createOrg.subtitle': 'Comienza un espacio de trabajo nuevo',

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

  'signatures.loading': 'Cargando tus acuerdos…',
  'signatures.restart':
    'Esta sesión de firma ya no está disponible. Vuelve a la aplicación y reinicia el inicio de sesión.',
  'signatures.intro':
    '{domain} exige los siguientes acuerdos vigentes antes de finalizar el inicio de sesión.',
  'signatures.expires': 'Esta sesión segura de firma caduca a las {time}.',
  'signatures.sourceError': 'No se pudo cargar el documento fuente verificado. Inténtalo de nuevo.',
  'signatures.receiptError': 'No se pudo descargar el recibo verificado. Inténtalo de nuevo.',
  'signatures.signError': 'No se pudo firmar el acuerdo. Revisa tu confirmación e inténtalo de nuevo.',
  'signatures.signed': 'Acuerdo firmado. Tu recibo de evidencia autenticada está listo abajo.',
  'signatures.version': 'Versión {version}',
  'signatures.downloadSource': 'Descargar PDF fuente',
  'signatures.loadingDocument': 'Cargando PDF verificado…',
  'signatures.viewerTitle': 'Visor PDF de {title}',
  'signatures.confirmTitle': 'Declaración de aceptación',
  'signatures.confirmCheckbox': 'Confirmo expresamente la declaración de aceptación mostrada arriba.',
  'signatures.fullName': 'Tu nombre completo',
  'signatures.nameAssertion':
    'Tu nombre escrito se registra como una afirmación tuya. No constituye una verificación independiente de identidad.',
  'signatures.evidenceNotice':
    'UOA registra evidencia autenticada del acuerdo y verifica su integridad. No es una notarización, una firma electrónica cualificada ni asesoramiento jurídico.',
  'signatures.signing': 'Firmando…',
  'signatures.signContinue': 'Firmar y continuar',
  'signatures.completeTitle': 'Todos los acuerdos vigentes están firmados',
  'signatures.completeBody':
    'Descarga los recibos que necesites y finaliza el inicio de sesión. Los requisitos se comprueban una vez más antes de conceder acceso.',
  'signatures.receiptsTitle': 'Recibos de evidencia',
  'signatures.verificationReference': 'Referencia de verificación',
  'signatures.revoked': 'Esta firma ha sido revocada.',
  'signatures.downloading': 'Descargando…',
  'signatures.downloadReceipt': 'Descargar recibo',
  'signatures.finishing': 'Finalizando…',
  'signatures.finish': 'Finalizar inicio de sesión',
} satisfies Translations;
