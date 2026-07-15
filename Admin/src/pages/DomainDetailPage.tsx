import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

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
import { useDomainQuery } from '../features/admin/admin-queries';

const DOMAIN_TABS = ['overview', 'organisations', 'teams', 'users', 'access', 'agreements', 'keys', 'email'] as const;
type DomainTab = (typeof DOMAIN_TABS)[number];

function isDomainTab(value: string | null): value is DomainTab {
  return value !== null && (DOMAIN_TABS as readonly string[]).includes(value);
}

export function DomainDetailPage() {
  const { domainId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading } = useDomainQuery(domainId);

  const tabParam = searchParams.get('tab');
  const tab: DomainTab = isDomainTab(tabParam) ? tabParam : 'overview';

  function selectTab(next: DomainTab) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === 'overview') {
          params.delete('tab');
        } else {
          params.set('tab', next);
        }
        return params;
      },
      { replace: true },
    );
  }

  if (isLoading) {
    return <p className="text-sm text-gray-400">Loading domain...</p>;
  }

  if (!data) {
    return <p className="text-sm text-gray-400">Domain not found.</p>;
  }

  const { domain, organisations, teams, users } = data;

  return (
    <>
      <PageHeader
        title={domain.name}
        description={domain.label || 'Domain directory'}
        leading={<Avatar label={domain.name} shape="square" size="md" />}
        badges={<StatusBadge status={domain.status} />}
        onBack={() => navigate('/domains')}
      />
      <UnderlineTabs<DomainTab>
        value={tab}
        onChange={selectTab}
        options={[
          { label: 'Overview', value: 'overview' },
          { label: 'Organisations', value: 'organisations', count: organisations.length },
          { label: 'Teams', value: 'teams', count: teams.length },
          { label: 'Users', value: 'users', count: users.length },
          { label: 'Access', value: 'access' },
          { label: 'Agreements', value: 'agreements' },
          { label: 'Signing keys', value: 'keys' },
          { label: 'Email', value: 'email' },
        ]}
      />
      {tab === 'overview' ? (
        <DomainOverviewTab
          domain={domain}
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
