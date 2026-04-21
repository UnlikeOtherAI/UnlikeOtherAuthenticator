import { Link, useLocation } from 'react-router-dom';

import { Icon } from '../components/icons/Icon';
import { Button } from '../components/ui/Button';
import { useAdminUi } from '../features/shell/admin-ui';
import { GlobalSearch } from './GlobalSearch';
import { navLabelForPath } from './navigation';

export function Topbar() {
  const location = useLocation();
  const { toggleSidebar } = useAdminUi();
  const label = navLabelForPath(location.pathname);

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 md:px-6">
      <Button className="md:hidden" variant="ghost" size="sm" icon="menu" aria-label="Toggle navigation" onClick={toggleSidebar} />
      <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <Link to="/dashboard" className="text-gray-400 transition-colors hover:text-gray-700">
          Admin
        </Link>
        <Icon name="chevronRight" className="h-3.5 w-3.5 text-gray-300" />
        <span className="truncate font-medium text-gray-900">{label}</span>
      </nav>
      <GlobalSearch />
      <button className="relative rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600" type="button" aria-label="Notifications">
        <Icon name="bell" className="h-5 w-5" />
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
      </button>
    </header>
  );
}
