import React, { useState } from 'react';

import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitTeamSelection } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/**
 * Phase 3c (design §11.2): rendered only when `can_create_org`. Posts an empty selection —
 * `/auth/select-team` with neither `teamId` nor `inviteId` — so an org-less user still completes
 * login with a plain code; the consuming product renders its own create-org flow from there. Do
 * NOT build an org-creation form here (out of scope for this step).
 */
export function CreateWorkspaceCard(props: {
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    setSubmitting(true);
    const outcome = await submitTeamSelection({ loginToken: props.loginToken, ...props.query });
    setSubmitting(false);
    props.onOutcome(outcome);
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={props.disabled || submitting}
      className={[
        'flex w-full items-center gap-3 rounded-[var(--uoa-radius-card)] border border-dashed border-[var(--uoa-color-border)]',
        'bg-transparent px-3 py-3 text-left transition-colors',
        'hover:border-[var(--uoa-color-primary)] disabled:cursor-not-allowed disabled:opacity-60',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--uoa-radius-button)] border border-[var(--uoa-color-border)] text-lg text-[var(--uoa-color-primary)]"
      >
        +
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--uoa-color-text)]">
          {t('workspace.createOrg.title')}
        </span>
        <span className="block truncate text-xs text-[var(--uoa-color-muted)]">
          {t('workspace.createOrg.subtitle')}
        </span>
      </span>
    </button>
  );
}
