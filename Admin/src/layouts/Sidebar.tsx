import { NavLink } from 'react-router';

import { Icon } from '../components/icons/Icon';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { adminAssets } from '../config/assets';
import { useIntegrationRequestsQuery } from '../features/admin/admin-queries';
import { UserAvatar } from '../features/admin/UserAvatar';
import { useAdminSession, useAdminSessionActions } from '../features/auth/admin-session';
import { useAdminUi } from '../features/shell/admin-ui';
import { cn } from '../utils/cn';
import { formatCompactCount } from '../utils/format-count';
import { navSections, type NavItem } from './navigation';

type SidebarBadge = {
  label: string;
  tone: 'alert' | 'default';
};

export function Sidebar() {
  const { data: integrationRequests } = useIntegrationRequestsQuery('PENDING');
  const pendingIntegrationCount = integrationRequests?.length ?? 0;
  const { adminUser } = useAdminSession();
  const { signOut } = useAdminSessionActions();
  const { closeSidebar, isSidebarOpen } = useAdminUi();

  return (
    <>
      <button
        className={cn('fixed inset-0 z-30 bg-black/50 md:hidden', isSidebarOpen ? 'block' : 'hidden')}
        type="button"
        aria-label="Close navigation"
        onClick={closeSidebar}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-60 shrink-0 flex-col overflow-y-auto bg-slate-900 transition-transform md:sticky md:top-0 md:translate-x-0',
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-center border-b border-slate-800 px-4">
          <img src={adminAssets.adminIcon} width="56" height="56" className="h-14 w-14 rounded-xl object-cover" alt="UOA" />
        </div>
        <nav className="flex-1 px-2 py-2">
          {navSections.map((section) => {
            const visibleItems = section.items
              .map((item) => ({ item, badge: item.badgeKey && pendingIntegrationCount > 0 ? { label: formatCompactCount(pendingIntegrationCount), tone: 'alert' as const } : undefined }));

            if (visibleItems.length === 0) {
              return null;
            }

            return (
              <div key={section.label}>
                {section.label ? <p className="mb-1 mt-4 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 first:mt-2">{section.label}</p> : null}
                {visibleItems.map(({ item, badge }) => (
                  <SidebarLink key={item.path} item={item} badge={badge} onClick={closeSidebar} />
                ))}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-slate-800 p-2">
          <button aria-label="Sign out" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-slate-800" type="button" onClick={signOut}>
            {adminUser?.id ? (
              <UserAvatar userId={adminUser.id} label={adminUser.email} />
            ) : (
              <Avatar label={adminUser?.email ?? 'Administrator'} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-200">{adminUser?.email ?? 'Administrator'}</span>
              <span className="block text-xs text-slate-400">Sign out</span>
            </span>
            <Icon name="logout" className="h-4 w-4 shrink-0 text-slate-500" />
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarLink({ badge, item, onClick }: { badge?: SidebarBadge; item: NavItem; onClick: () => void }) {
  return (
    <NavLink
      to={item.path}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'mb-0.5 flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
          isActive ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
        )
      }
    >
      <Icon name={item.icon} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge ? (
        <Badge
          className={cn(
            'shrink-0',
            badge.tone === 'alert' ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-300',
          )}
        >
          {badge.label}
        </Badge>
      ) : null}
    </NavLink>
  );
}


