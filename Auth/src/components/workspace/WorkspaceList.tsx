import React from 'react';

import { OrgSectionHeader } from './OrgSectionHeader.js';
import { WorkspaceCard } from './WorkspaceCard.js';
import type { TeamChoice } from '../../hooks/use-popup.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

type OrgSection = {
  orgId: string;
  orgName: string | null;
  teams: TeamChoice[];
};

/**
 * Groups the chooser by organisation, preserving the server's team order within each.
 *
 * An org is the level above a workspace, and two orgs can each have a workspace called "General" —
 * without the grouping those rows are indistinguishable. Orgs appear in the order their first
 * workspace does. The chooser-level creation dialog owns the destination chooser, so an
 * organisation with no existing workspace does not add an empty section to the list.
 */
function buildSections(teams: TeamChoice[]): OrgSection[] {
  const sections = new Map<string, OrgSection>();

  for (const team of teams) {
    const existing = sections.get(team.orgId);
    if (existing) {
      existing.teams.push(team);
      continue;
    }
    sections.set(team.orgId, {
      orgId: team.orgId,
      orgName: team.orgName ?? null,
      teams: [team],
    });
  }

  return [...sections.values()];
}

/** Phase 3c (design §11.2): the chooser's workspace stack, grouped by owning organisation. */
export function WorkspaceList(props: {
  teams: TeamChoice[];
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const sections = buildSections(props.teams);
  // A single group needs no heading — grouping only earns its space when it disambiguates names.
  const showOrgNames = sections.length > 1;

  return (
    <div className="flex flex-col gap-5">
      {sections.map((section) => {
        return (
          <div key={section.orgId} className="flex flex-col gap-3">
            {showOrgNames && section.orgName ? (
              <OrgSectionHeader orgName={section.orgName} />
            ) : null}

            {section.teams.map((team) => (
              <WorkspaceCard
                key={team.teamId}
                team={team}
                loginToken={props.loginToken}
                query={props.query}
                onOutcome={props.onOutcome}
                disabled={props.disabled}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
