import { useMemo } from 'react';
import { Link } from 'react-router';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type { BillingService } from '../../schemas/billing';
import { useOrganisationsQuery, useTeamsQuery } from './admin-queries';
import { useBillingNavigation } from './billing-navigation';
import { billingActiveProducts } from './billing-organisation-tariffs';
import { BillingOrganisationList } from './BillingOrganisationList';
import { BillingOrganisationView } from './BillingOrganisationView';

/**
 * Admin → Billing → Organisations: pick an organisation, then edit its own tariff and each
 * team's, per product. Contract: Docs/plans/2026-11-16-billing-admin-cleanup.md §4.
 */
export function BillingOrganisationsSection({
  services,
  servicesError,
  servicesLoading,
}: {
  services: BillingService[];
  servicesError: boolean;
  servicesLoading: boolean;
}) {
  const organisationsQuery = useOrganisationsQuery();
  const teamsQuery = useTeamsQuery();
  const { params, href } = useBillingNavigation();
  const products = useMemo(() => billingActiveProducts(services), [services]);
  const organisations = useMemo(() => organisationsQuery.data ?? [], [organisationsQuery.data]);
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
  const organisationId = params.get('organisation');
  const backLink = (
    <Link
      className="text-sm text-blue-600 hover:underline"
      to={href({ organisation: null, organisation_teams_page: null })}
    >
      All organisations
    </Link>
  );

  if (servicesLoading || organisationsQuery.isLoading || teamsQuery.isLoading) {
    return <Card className="px-5 py-8 text-sm text-gray-400">Loading organisations...</Card>;
  }
  if (servicesError || organisationsQuery.isError || teamsQuery.isError) {
    return (
      <Card className="border-red-200 px-5 py-8 text-sm text-red-600">
        {servicesError ? 'Could not load products.' : 'Could not load organisations.'}
        {!servicesError ? (
          <Button
            className="ml-3"
            onClick={() => void Promise.all([organisationsQuery.refetch(), teamsQuery.refetch()])}
          >
            Retry
          </Button>
        ) : null}
      </Card>
    );
  }
  if (!organisationId) {
    return <BillingOrganisationList organisations={organisations} products={products} teams={teams} />;
  }
  const organisation = organisations.find((entry) => entry.id === organisationId);
  return (
    <div className="space-y-4">
      {backLink}
      {organisation ? (
        <BillingOrganisationView organisation={organisation} products={products} teams={teams} />
      ) : (
        <Card className="p-5 text-sm">Organisation unavailable.</Card>
      )}
    </div>
  );
}
