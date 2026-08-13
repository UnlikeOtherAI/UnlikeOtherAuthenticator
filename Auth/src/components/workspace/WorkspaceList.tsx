import React, { useState } from 'react';

import { CreateTeamForm } from './CreateTeamForm.js';
import { OrgSectionHeader } from './OrgSectionHeader.js';
import { WorkspaceCard } from './WorkspaceCard.js';
import type { CreatableOrgChoice, TeamChoice } from '../../hooks/use-popup.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

type OrgSection = {
  orgId: string;
  orgName: string | null;
  teams: TeamChoice[];
  creatable: boolean;
};

/**
 * Groups the chooser by organisation, preserving the server's team order within each.
 *
 * An org is the level above a workspace, and two orgs can each have a workspace called "General" —
 * without the grouping those rows are indistinguishable. Orgs appear in the order their first
 * workspace does; an org the user may create in but has no workspace in yet comes last.
 */
function buildSections(teams: TeamChoice[], creatableOrgs: CreatableOrgChoice[]): OrgSection[] {
  const creatableById = new Map(creatableOrgs.map((org) => [org.orgId, org]));
  const sections = new Map<string, OrgSection>();

  for (const team of teams) {
    const existing = sections.get(team.orgId);
    if (existing) {
      existing.teams.push(team);
      continue;
    }
    sections.set(team.orgId, {
      orgId: team.orgId,
      orgName: team.orgName ?? creatableById.get(team.orgId)?.orgName ?? null,
      teams: [team],
      creatable: creatableById.has(team.orgId),
    });
  }

  for (const org of creatableOrgs) {
    if (sections.has(org.orgId)) continue;
    sections.set(org.orgId, {
      orgId: org.orgId,
      orgName: org.orgName,
      teams: [],
      creatable: true,
    });
  }

  return [...sections.values()];
}

/** Phase 3c (design §11.2): the chooser's workspace stack, grouped by owning organisation. */
export function WorkspaceList(props: {
  teams: TeamChoice[];
  creatableOrgs?: CreatableOrgChoice[];
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  // One creation form open at a time, across every group: eight half-open forms would be a page of
  // inputs and a scrambled tab order. Owned here rather than per-card so opening one closes the
  // rest. Starts closed, so the server render and the first client render agree.
  const [creatingOrgId, setCreatingOrgId] = useState<string | null>(null);

  const creatableOrgs = props.creatableOrgs ?? [];
  const sections = buildSections(props.teams, creatableOrgs);
  // A single non-creatable group needs no heading — the grouping only earns its space when it
  // disambiguates. A creatable one always shows it, because the heading anchors the "+" and names
  // where the new workspace lands.
  const showOrgNames = sections.length > 1;

  return (
    <div className="flex flex-col gap-5">
      {sections.map((section) => {
        const formId = `create-team-${section.orgId}`;
        const expanded = creatingOrgId === section.orgId;
        const canCreate = section.creatable && section.orgName !== null;

        return (
          <div key={section.orgId} className="relative flex flex-col gap-3">
            {(showOrgNames || canCreate) && section.orgName ? (
              <OrgSectionHeader
                orgName={section.orgName}
                formId={formId}
                expanded={expanded}
                disabled={props.disabled}
                overlapCreateControl={section.teams.length > 0 || expanded}
                onToggleCreate={
                  canCreate
                    ? () => setCreatingOrgId(expanded ? null : section.orgId)
                    : undefined
                }
              />
            ) : null}

            {expanded ? (
              <CreateTeamForm
                id={formId}
                orgId={section.orgId}
                loginToken={props.loginToken}
                query={props.query}
                onOutcome={props.onOutcome}
                onCancel={() => setCreatingOrgId(null)}
                disabled={props.disabled}
              />
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
