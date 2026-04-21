export function isEmailPasswordEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const methods = (config as Record<string, unknown>).enabled_auth_methods;
  return Array.isArray(methods) && methods.includes('email_password');
}

export function isRegistrationAllowed(config: unknown): boolean {
  if (!config || typeof config !== 'object') return true;
  return (config as Record<string, unknown>).allow_registration !== false;
}
