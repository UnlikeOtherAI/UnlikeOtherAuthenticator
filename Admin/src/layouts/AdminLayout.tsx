import { Outlet } from 'react-router';

import { ConfirmDialog } from '../components/dialogs/ConfirmDialog';
import { DebugFab } from '../components/DebugFab';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { UserDetailsModal } from '../components/dialogs/UserDetailsModal';

export function AdminLayout() {
  return (
    <div className="flex h-full bg-gray-50">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        <Topbar />
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
      <UserDetailsModal />
      <ConfirmDialog />
      {/* DEV-gated like adminEnv.bypassAuth: a support-debug surface has no place in a production build. */}
      {import.meta.env.DEV ? <DebugFab /> : null}
    </div>
  );
}
