import React, { useState } from 'react';

import { useTranslation } from '../../i18n/use-translation.js';
import type { TeamChoice } from '../../hooks/use-popup.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitTeamSelection } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';
import { workspaceAvatarColor, workspaceInitials } from '../../utils/workspace-icon.js';

/**
 * Phase 3c (design §11.2/§11.3): one ACTIVE workspace in the chooser. The whole card is the
 * button — clicking it selects that team. Icon falls back to a deterministic initials-on-color
 * badge (`utils/workspace-icon.ts`) when the team has no `iconUrl`.
 */
export function WorkspaceCard(props: {
  team: TeamChoice;
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    const outcome = await submitTeamSelection({
      loginToken: props.loginToken,
      teamId: props.team.teamId,
      ...props.query,
    });
    setSubmitting(false);
    props.onOutcome(outcome);
  }

  const showRole = props.team.role === 'owner' || props.team.role === 'admin';
  const roleLabel =
    props.team.role === 'owner' ? t('workspace.role.owner') : t('workspace.role.admin');

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={props.disabled || submitting}
      className={[
        'flex w-full items-center gap-3 rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)]',
        'bg-[var(--uoa-color-surface)] px-3 py-3 text-left transition-colors',
        'hover:border-[var(--uoa-color-primary)] disabled:cursor-not-allowed disabled:opacity-60',
      ].join(' ')}
    >
      {props.team.iconUrl ? (
        <img
          src={props.team.iconUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-[var(--uoa-radius-button)] object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--uoa-radius-button)] text-sm font-semibold text-white"
          style={{ backgroundColor: workspaceAvatarColor(props.team.teamId) }}
        >
          {workspaceInitials(props.team.name)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--uoa-color-text)]">
          {props.team.name}
        </span>
        {showRole ? (
          <span className="block truncate text-xs text-[var(--uoa-color-muted)]">{roleLabel}</span>
        ) : null}
      </span>
    </button>
  );
}
