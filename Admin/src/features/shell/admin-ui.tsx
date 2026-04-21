import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

type Confirmation = {
  title: string;
  body: string;
} | null;

type AdminUiContextValue = {
  confirmation: Confirmation;
  isSidebarOpen: boolean;
  selectedUserId: string | null;
  closeConfirmation: () => void;
  closeSidebar: () => void;
  closeUser: () => void;
  confirm: (title: string, body: string) => void;
  openUser: (userId: string) => void;
  toggleSidebar: () => void;
};

const AdminUiContext = createContext<AdminUiContextValue | null>(null);

export function AdminUiProvider({ children }: PropsWithChildren) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const value = useMemo<AdminUiContextValue>(
    () => ({
      confirmation,
      isSidebarOpen,
      selectedUserId,
      closeConfirmation: () => setConfirmation(null),
      closeSidebar: () => setIsSidebarOpen(false),
      closeUser: () => setSelectedUserId(null),
      confirm: (title, body) => setConfirmation({ title, body }),
      openUser: setSelectedUserId,
      toggleSidebar: () => setIsSidebarOpen((current) => !current),
    }),
    [confirmation, isSidebarOpen, selectedUserId],
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
