import { useLocation, useParams, useSearchParams } from 'react-router';

import { Avatar } from '../components/ui/Avatar';
import { PageHeader } from '../components/ui/PageHeader';
import { StatusBadge } from '../components/ui/Status';
import { UnderlineTabs } from '../components/ui/Tabs';
import { DomainSigningKeysSection } from '../components/sections/DomainSigningKeysSection';
import { Card } from '../components/ui/Card';
import { DomainAccessTab } from '../features/admin/DomainAccessTab';
import { DomainAgreementsTab } from '../features/admin/DomainAgreementsTab';
import { DomainEmailSection } from '../features/admin/DomainEmailSection';
import { DomainOverviewTab } from '../features/admin/DomainOverviewTab';
import {
  DomainOrganisationsTab,
  DomainTeamsTab,
  DomainUsersTab,
} from '../features/admin/DomainDirectoryTabs';
import { useDirectoryNavigation } from '../features/admin/useDirectoryNavigation';
import { useDomainQuery } from '../features/admin/admin-queries';

const DOMAIN_TABS = ['overview', 'credentials', 'organisations', 'teams', 'users', 'access', 'agreements', 'keys', 'email'] as const;
type DomainTab = (typeof DOMAIN_TABS)[number];

function isDomainTab(value: string | null): value is DomainTab {
  return value !== null && (DOMAIN_TABS as readonly string[]).includes(value);
}

export function DomainDetailPage() {
  const { domainId } = useParams();
  const location = useLocation();
  const { goBack } = useDirectoryNavigation('/domains');
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, isError, refetch } = useDomainQuery(domainId);

  const tabParam = searchParams.get('tab');
  const tab: DomainTab = isDomainTab(tabParam) ? tabParam : 'overview';

  function selectTab(next: DomainTab) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.delete('q');
        params.delete('page');
        if (next === 'overview') {
          params.delete('tab');
        } else {
          params.set('tab', next);
        }
        return params;
      },
      { replace: false, state: location.state },
    );
  }

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading domain...</p>;
  }

  if (isError) return <p role="alert">Could not load service. <button onClick={() => refetch()}>Retry</button></p>;

  if (!data) {
    return <p className="text-sm text-gray-400">Domain not found.</p>;
  }

  const { domain, organisations, teams, users } = data;

  return (
    <>
      <PageHeader
        title={domain.label || domain.name}
        description={domain.label && domain.label !== domain.name ? domain.name : ''}
        leading={<Avatar label={domain.name} shape="square" size="md" />}
        badges={<StatusBadge status={domain.status} />}
        onBack={goBack}
      />
      <UnderlineTabs<DomainTab>
        value={tab}
        onChange={selectTab}
        options={[
          { label: 'Overview', value: 'overview' },
          { label: 'Organisations', value: 'organisations' },
          { label: 'Teams', value: 'teams' },
          { label: 'Users', value: 'users' },
          { label: 'Access', value: 'access' },
          { label: 'Credentials', value: 'credentials' },
          { label: 'Agreements', value: 'agreements' },
          { label: 'Signing keys', value: 'keys' },
          { label: 'Email', value: 'email' },
        ]}
      />
      {tab === 'overview' || tab === 'credentials' ? (
        <DomainOverviewTab
          domain={domain}
          section={tab}
          counts={{ organisations: organisations.length, teams: teams.length, users: users.length }}
        />
      ) : null}
      {tab === 'organisations' ? <DomainOrganisationsTab organisations={organisations} /> : null}
      {tab === 'teams' ? <DomainTeamsTab teams={teams} /> : null}
      {tab === 'users' ? <DomainUsersTab users={users} /> : null}
      {tab === 'access' ? <DomainAccessTab domain={domain} /> : null}
      {tab === 'agreements' ? <DomainAgreementsTab domain={domain.name} /> : null}
      {tab === 'keys' ? (
        <Card className="p-5">
          <DomainSigningKeysSection domain={domain.name} />
        </Card>
      ) : null}
      {tab === 'email' ? <DomainEmailSection domain={domain.name} /> : null}
    </>
  );
}
