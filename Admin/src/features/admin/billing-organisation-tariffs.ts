import type { BillingAssignment, BillingService, BillingTariff } from '../../schemas/billing';
import {
  billingMonthIsFuture,
  billingMonthStart,
  billingTariffLabel,
  nextBillingMonth,
} from './billing-format';

// Pure derivations for Admin → Billing → Organisations (Docs/plans/2026-11-16-billing-admin-cleanup.md §4).

type OrganisationLike = { id: string; name: string; slug: string };
type TeamLike = { id: string; orgId: string; name: string; members: number };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Products an operator can work with here: active ones, by name. */
export function billingActiveProducts(services: BillingService[]): BillingService[] {
  return services.filter((service) => service.active).sort(byName);
}

/** Tariffs that can be given to somebody: never a retired version. */
export function billingAssignableTariffs(service: BillingService): BillingTariff[] {
  return service.tariffs
    .filter((tariff) => tariff.retired_at === null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key) || b.version - a.version);
}

export function billingDefaultTariff(service: BillingService): BillingTariff | null {
  return service.tariffs.find((tariff) => tariff.is_default) ?? null;
}

function organisationAssignment(service: BillingService, organisationId: string) {
  return service.assignments.find((assignment) =>
    assignment.scope === 'organisation' && assignment.organisation.id === organisationId) ?? null;
}

function teamAssignments(service: BillingService, organisationId: string) {
  return service.assignments.filter((assignment) =>
    assignment.scope === 'team' && assignment.organisation.id === organisationId && assignment.team);
}

/** The short tariff label within its product (see `billingTariffLabel`); "—" when there is none. */
function label(tariff: BillingTariff | null, service: BillingService): string {
  return tariff ? billingTariffLabel(tariff, service.tariffs) : '—';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export type BillingOrganisationListRow = {
  id: string;
  name: string;
  slug: string;
  teamCount: number;
  /** Lines for the organisation's own tariff; empty renders `tariffFallback` in grey. */
  tariffLines: string[];
  tariffFallback: string;
  /** Lines for the team tariffs; empty renders "—". */
  teamLines: string[];
};

/** The Organisations list (§4.1): filtered by search, product and "With custom tariffs", sorted by name. */
export function billingOrganisationListRows(input: {
  organisations: OrganisationLike[];
  teams: TeamLike[];
  services: BillingService[];
  productId: string | null;
  query: string;
  customOnly: boolean;
}): BillingOrganisationListRow[] {
  const products = billingActiveProducts(input.services);
  const product = products.find((service) => service.id === input.productId) ?? null;
  const scope = product ? [product] : products;
  const needle = input.query.trim().toLowerCase();
  return input.organisations
    .filter((organisation) => !needle ||
      `${organisation.name} ${organisation.slug}`.toLowerCase().includes(needle))
    .filter((organisation) => !input.customOnly || scope.some((service) =>
      service.assignments.some((assignment) => assignment.organisation.id === organisation.id)))
    .sort(byName)
    .map((organisation) => {
      const base = {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        teamCount: input.teams.filter((team) => team.orgId === organisation.id).length,
      };
      if (product) {
        const own = organisationAssignment(product, organisation.id);
        return {
          ...base,
          tariffLines: own ? [label(own.tariff, product)] : [],
          tariffFallback: `Product default — ${label(billingDefaultTariff(product), product)}`,
          teamLines: teamAssignments(product, organisation.id)
            .sort((a, b) => (a.team?.name ?? '').localeCompare(b.team?.name ?? ''))
            .map((assignment) => `${assignment.team?.name}: ${label(assignment.tariff, product)}`),
        };
      }
      const customTeams = new Set(products.flatMap((service) =>
        teamAssignments(service, organisation.id).map((assignment) => assignment.team?.id)));
      return {
        ...base,
        tariffLines: products.flatMap((service) => {
          const own = organisationAssignment(service, organisation.id);
          return own ? [`${service.name}: ${label(own.tariff, service)}`] : [];
        }),
        tariffFallback: 'Product defaults',
        teamLines: customTeams.size ? [plural(customTeams.size, 'team')] : [],
      };
    });
}

/** Assignments the organisation and its teams hold in one product (the product tab count). */
export function billingOrganisationAssignmentCount(service: BillingService, organisationId: string): number {
  return service.assignments.filter((assignment) => assignment.organisation.id === organisationId).length;
}

export type BillingTariffRowModel = {
  /** "organisation" or the team id. */
  key: string;
  teamId: string | null;
  /** The organisation or team name, as the confirmation copy names it. */
  name: string;
  members: number | null;
  assignment: BillingAssignment | null;
  /** The select value of what is saved: the assigned tariff, or "" for the fallback. */
  savedValue: string;
  /** What "" resolves to. */
  fallback: BillingTariff | null;
  options: Array<{ value: string; label: string }>;
};

/** The one-organisation table (§4.2): the organisation row, then each team by name. */
export function billingOrganisationTariffRows(
  service: BillingService,
  organisation: OrganisationLike,
  teams: TeamLike[],
): { organisationRow: BillingTariffRowModel; teamRows: BillingTariffRowModel[] } {
  const productDefault = billingDefaultTariff(service);
  const own = organisationAssignment(service, organisation.id);
  const organisationResolves = own?.tariff ?? productDefault;
  const tariffOptions = billingAssignableTariffs(service)
    .map((tariff) => ({ value: tariff.id, label: label(tariff, service) }));
  const teamOwn = teamAssignments(service, organisation.id);
  return {
    organisationRow: {
      key: 'organisation',
      teamId: null,
      name: organisation.name,
      members: null,
      assignment: own,
      savedValue: own?.tariff_id ?? '',
      fallback: productDefault,
      options: [
        { value: '', label: `Product default — ${label(productDefault, service)}` },
        ...tariffOptions,
      ],
    },
    teamRows: teams
      .filter((team) => team.orgId === organisation.id)
      .sort(byName)
      .map((team) => {
        const assignment = teamOwn.find((entry) => entry.team?.id === team.id) ?? null;
        return {
          key: team.id,
          teamId: team.id,
          name: team.name,
          members: team.members,
          assignment,
          savedValue: assignment?.tariff_id ?? '',
          fallback: organisationResolves,
          options: [
            { value: '', label: `Same as organisation — ${label(organisationResolves, service)}` },
            ...tariffOptions,
          ],
        };
      }),
  };
}

/** Amber note under a saved assignment that has not started yet. */
export function billingAssignmentStartNote(
  assignment: BillingAssignment | null,
  now: Date = new Date(),
): string | null {
  const month = assignment?.effective_from_month ?? null;
  return month && billingMonthIsFuture(month, now) ? `Starts ${billingMonthStart(month)}` : null;
}

export type BillingTariffChange =
  | { kind: 'save'; tariffId: string; title: string; body: string }
  | { kind: 'remove'; assignmentId: string; title: string; body: string };

/** What pressing Save on a row does, with its confirmation copy; null when nothing changed. */
export function billingTariffChange(
  service: BillingService,
  row: BillingTariffRowModel,
  value: string,
  now: Date = new Date(),
): BillingTariffChange | null {
  if (value === row.savedValue) return null;
  const starts = billingMonthStart(nextBillingMonth(now));
  if (value === '') {
    if (!row.assignment) return null;
    return {
      kind: 'remove',
      assignmentId: row.assignment.id,
      title: `Remove ${row.name}'s own tariff?`,
      body: `From ${starts} (UTC) ${row.name} uses ${row.fallback ? label(row.fallback, service) : 'no tariff'}.`,
    };
  }
  const tariff = service.tariffs.find((entry) => entry.id === value);
  if (!tariff) return null;
  const name = label(tariff, service);
  return {
    kind: 'save',
    tariffId: tariff.id,
    title: `Move ${row.name} to ${name}?`,
    body: `${row.name} uses ${name} for ${service.name} from ${starts} (UTC). This month keeps its current terms.${
      row.teamId === null ? ' Teams with their own tariff are not affected.' : ''}`,
  };
}
