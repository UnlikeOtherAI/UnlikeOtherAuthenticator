import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

type Confirmation = {
  title: string;
  body: string;
  onConfirm?: () => Promise<void> | void;
  requiredText?: string;
  failureMessage?: string;
} | null;

type AdminUiContextValue = {
  confirmation: Confirmation;
  isSidebarOpen: boolean;
  closeConfirmation: () => void;
  closeSidebar: () => void;
  confirm: (
    title: string,
    body: string,
    onConfirm?: () => Promise<void> | void,
    requiredText?: string,
    failureMessage?: string,
  ) => void;
  toggleSidebar: () => void;
};

const AdminUiContext = createContext<AdminUiContextValue | null>(null);

export function AdminUiProvider({ children }: PropsWithChildren) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const value = useMemo<AdminUiContextValue>(
    () => ({
      confirmation,
      isSidebarOpen,
      closeConfirmation: () => setConfirmation(null),
      closeSidebar: () => setIsSidebarOpen(false),
      confirm: (title, body, onConfirm, requiredText, failureMessage) =>
        setConfirmation({ title, body, onConfirm, requiredText, failureMessage }),
      toggleSidebar: () => setIsSidebarOpen((current) => !current),
    }),
    [confirmation, isSidebarOpen],
  );

  return <AdminUiContext.Provider value={value}>{children}</AdminUiContext.Provider>;
}

export function useAdminUi() {
  const value = useContext(AdminUiContext);

  if (!value) {
    throw new Error('AdminUiProvider is missing.');
  }

  return value;
}
