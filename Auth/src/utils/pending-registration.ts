export type PendingRegistration = { id: string; email: string };

export function registrationStorageKey(configUrl: string, search: string): string {
  return `uoa:registration:${configUrl}:${search}`;
}

// Only a display address and public id are persisted. The capability is an
// HttpOnly cookie; copying this storage cannot subscribe, verify or complete.
export function readPendingRegistration(key: string): PendingRegistration | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'id' in value && 'email' in value &&
      typeof value.id === 'string' && /^[0-9a-f-]{36}$/.test(value.id) && typeof value.email === 'string') {
      return { id: value.id, email: value.email };
    }
  } catch { /* Storage may be disabled; the current in-memory flow still works. */ }
  return null;
}

export function savePendingRegistration(key: string, value: PendingRegistration | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch { /* The cookie remains authoritative. */ }
}
