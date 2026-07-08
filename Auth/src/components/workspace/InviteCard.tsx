import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { InviteChoice } from '../../hooks/use-popup.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitTeamSelection } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/**
 * Phase 3c (design §11.2): a visually distinct pending-invite card. Accept continues into that
 * workspace's policy checks like any other card; Decline refreshes the chooser payload in place
 * (the response is the same shape select-team's chooser branch returns) and the user stays put.
 */
export function InviteCard(props: {
  invite: InviteChoice;
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState<'accept' | 'decline' | null>(null);

  async function respond(action: 'accept' | 'decline') {
    setSubmitting(action);
    const outcome = await submitTeamSelection({
      loginToken: props.loginToken,
      inviteId: props.invite.inviteId,
      action,
      ...props.query,
    });
    setSubmitting(null);
    props.onOutcome(outcome);
  }

  const busy = submitting !== null;

  return (
    <div
      className={[
        'flex flex-col gap-3 rounded-[var(--uoa-radius-card)] border border-dashed border-[var(--uoa-color-primary)]',
        'bg-[var(--uoa-color-surface)] px-3 py-3',
      ].join(' ')}
    >
      <div>
        <p className="text-sm font-medium text-[var(--uoa-color-text)]">
          {t('workspace.invite.title', { teamName: props.invite.teamName })}
        </p>
        {props.invite.invitedBy ? (
          <p className="mt-1 text-xs text-[var(--uoa-color-muted)]">
            {t('workspace.invite.invitedBy', { invitedBy: props.invite.invitedBy })}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="primary"
          disabled={props.disabled || busy}
          onClick={() => void respond('accept')}
        >
          {submitting === 'accept' ? '...' : t('workspace.invite.accept')}
        </Button>
        <button
          type="button"
          disabled={props.disabled || busy}
          onClick={() => void respond('decline')}
          className="text-sm text-[var(--uoa-color-muted)] hover:underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting === 'decline' ? '...' : t('workspace.invite.decline')}
        </button>
      </div>
    </div>
  );
}
