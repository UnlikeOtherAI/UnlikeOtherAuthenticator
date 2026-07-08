export function isEmailPasswordEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const methods = (config as Record<string, unknown>).enabled_auth_methods;
  return Array.isArray(methods) && methods.includes('email_password');
}

export function isRegistrationAllowed(config: unknown): boolean {
  if (!config || typeof config !== 'object') return true;
  return (config as Record<string, unknown>).allow_registration !== false;
}

/** Phase 3c (design §11.2): whether `/auth/start` also issues a 6-digit email sign-in code. */
export function isEmailCodeEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const loginFlow = (config as Record<string, unknown>).login_flow;
  if (!loginFlow || typeof loginFlow !== 'object') return false;
  return (loginFlow as Record<string, unknown>).email_code_enabled === true;
}
