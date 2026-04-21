import { Outlet } from 'react-router-dom';

import { AdminActionDialog } from './AdminActionDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { UserDetailsModal } from './UserDetailsModal';

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
      <AdminActionDialog />
      <UserDetailsModal />
      <ConfirmDialog />
    </div>
  );
}
