const storageKey = 'uoa-admin-session';

export type StoredAdminSession = {
  accessToken: string;
  expiresAt: number;
};

export function readStoredAdminSession(): StoredAdminSession | null {
  try {
    const storedValue = window.sessionStorage.getItem(storageKey);
    if (!storedValue) return null;

    const parsed = JSON.parse(storedValue) as StoredAdminSession;
    if (!parsed.accessToken || parsed.expiresAt <= Date.now() + 5_000) {
      clearStoredAdminSession();
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function readAdminAccessToken(): string | null {
  return readStoredAdminSession()?.accessToken ?? null;
}

export function clearStoredAdminSession(): void {
  window.sessionStorage.removeItem(storageKey);
}

export function writeStoredAdminSession(accessToken: string, expiresInSeconds: number): void {
  const storedSession: StoredAdminSession = {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1_000,
  };
  window.sessionStorage.setItem(storageKey, JSON.stringify(storedSession));
}
