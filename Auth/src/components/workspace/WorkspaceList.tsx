import React from 'react';

import { WorkspaceCard } from './WorkspaceCard.js';
import type { TeamChoice } from '../../hooks/use-popup.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/** Phase 3c (design §11.2): vertical stack of `WorkspaceCard`s, server order preserved. */
export function WorkspaceList(props: {
  teams: TeamChoice[];
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {props.teams.map((team) => (
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
}
