import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

import type { AppFlagSummary, BanRecord, Domain, FeatureFlagDefinition, KillSwitchEntry, Organisation, OrganisationMember, PreapprovedMember, Team, UserSummary } from '../admin/types';

type Confirmation = {
  title: string;
  body: string;
} | null;

export type AdminDialog =
  | { type: 'edit-domain'; domain: Domain }
  | { type: 'edit-org'; organisation: Organisation }
  | { type: 'transfer-ownership'; organisation: Organisation }
  | { type: 'add-team'; organisation: Organisation }
  | { type: 'edit-team'; organisation: Organisation; team: Team }
  | { type: 'add-member'; organisation: Organisation; team?: Team }
  | { type: 'edit-user'; user: UserSummary }
  | { type: 'add-user-to-team'; user: UserSummary; organisations: Organisation[] }
  | { type: 'change-org-role'; organisation: Organisation; member: OrganisationMember }
  | { type: 'change-team-role'; organisation: Organisation; team: Team; member: OrganisationMember }
  | { type: 'edit-ban'; ban: BanRecord; kind: 'email' | 'ip' | 'pattern' }
  | { type: 'add-ban'; kind: 'email' | 'ip' | 'pattern' }
  | { type: 'add-preapproval'; organisation: Organisation }
  | { type: 'edit-preapproval'; organisation: Organisation; preapproval: PreapprovedMember }
  | { type: 'register-app' }
  | { type: 'app-flags'; app: AppFlagSummary }
  | { type: 'app-settings'; app: AppFlagSummary }
  | { type: 'register-platform'; app: AppFlagSummary }
  | { type: 'add-feature-flag'; app: AppFlagSummary }
  | { type: 'edit-feature-flag'; app: AppFlagSummary; flag: FeatureFlagDefinition }
  | { type: 'add-kill-switch'; app: AppFlagSummary }
  | { type: 'edit-kill-switch'; app: AppFlagSummary; killSwitch: KillSwitchEntry };

type AdminUiContextValue = {
  activeDialog: AdminDialog | null;
  confirmation: Confirmation;
  isSidebarOpen: boolean;
  selectedUserId: string | null;
  closeDialog: () => void;
  closeConfirmation: () => void;
  closeSidebar: () => void;
  closeUser: () => void;
  confirm: (title: string, body: string) => void;
  openDialog: (dialog: AdminDialog) => void;
  openUser: (userId: string) => void;
  toggleSidebar: () => void;
};

const AdminUiContext = createContext<AdminUiContextValue | null>(null);

export function AdminUiProvider({ children }: PropsWithChildren) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [activeDialog, setActiveDialog] = useState<AdminDialog | null>(null);

  const value = useMemo<AdminUiContextValue>(
    () => ({
      activeDialog,
      confirmation,
      isSidebarOpen,
      selectedUserId,
      closeDialog: () => setActiveDialog(null),
      closeConfirmation: () => setConfirmation(null),
      closeSidebar: () => setIsSidebarOpen(false),
      closeUser: () => setSelectedUserId(null),
      confirm: (title, body) => setConfirmation({ title, body }),
      openDialog: setActiveDialog,
      openUser: setSelectedUserId,
      toggleSidebar: () => setIsSidebarOpen((current) => !current),
    }),
    [activeDialog, confirmation, isSidebarOpen, selectedUserId],
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
