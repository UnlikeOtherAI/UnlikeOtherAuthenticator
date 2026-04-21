import { Fragment, createContext, createElement, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { adminEnv } from '../../config/env';

const storageKey = 'uoa-admin-session';

type AdminUser = {
  email: string;
};

type AdminSessionContextValue = {
  adminUser: AdminUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string) => boolean;
  signOut: () => void;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function AdminSessionProvider({ children }: PropsWithChildren) {
  const [storedUser, setStoredUser] = useState<AdminUser | null>(() => readStoredSession());

  const adminUser = useMemo(() => (adminEnv.bypassAuth ? { email: 'admin@system.local' } : storedUser), [storedUser]);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      adminUser,
      isAuthenticated: Boolean(adminUser),
      isLoading: false,
      signIn(email) {
        if (!import.meta.env.DEV) {
          return false;
        }

        const nextUser = { email };
        window.localStorage.setItem(storageKey, JSON.stringify(nextUser));
        setStoredUser(nextUser);
        return true;
      },
      signOut() {
        window.localStorage.removeItem(storageKey);
        setStoredUser(null);
      },
    }),
    [adminUser],
  );

  return createElement(AdminSessionContext.Provider, { value }, children);
}

export function useAdminSession(): Pick<AdminSessionContextValue, 'adminUser' | 'isLoading' | 'isAuthenticated'> {
  const session = useRequiredAdminSessionContext();

  return {
    adminUser: session.adminUser,
    isLoading: session.isLoading,
    isAuthenticated: session.isAuthenticated,
  };
}

export function useAdminSessionActions() {
  const session = useRequiredAdminSessionContext();

  return {
    signIn: session.signIn,
    signOut: session.signOut,
  };
}

export function AdminSessionGuard({ children }: PropsWithChildren) {
  const location = useLocation();
  const session = useAdminSession();

  if (session.isLoading) {
    return null;
  }

  if (!session.isAuthenticated) {
    return createElement(Navigate, { to: '/login', replace: true, state: { from: location.pathname } });
  }

  return createElement(Fragment, null, children);
}

function useRequiredAdminSessionContext() {
  const session = useContext(AdminSessionContext);

  if (!session) {
    throw new Error('AdminSessionProvider is missing.');
  }

  return session;
}

function readStoredSession(): AdminUser | null {
  if (!import.meta.env.DEV) {
    return null;
  }

  try {
    const storedValue = window.localStorage.getItem(storageKey);
    return storedValue ? (JSON.parse(storedValue) as AdminUser) : null;
  } catch {
    return null;
  }
}
