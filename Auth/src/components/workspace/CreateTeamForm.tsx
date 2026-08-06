import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitTeamCreation } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/**
 * Names a new workspace inside one organisation the user already belongs to.
 *
 * Rendered directly under that organisation's header, opened by its "+" — at the bottom of a group
 * it would sit under the soft keyboard on a phone. The input takes focus on open because the user
 * asked for it by tapping; that is the opposite of the login screen, where focus nobody requested
 * is what put the keyboard over the social buttons.
 *
 * The server re-checks that this user is an ACTIVE owner/admin of `orgId` and that the domain
 * enabled `org_features.allow_user_create_team`; this only decides what to offer.
 */
export function CreateTeamForm(props: {
  id: string;
  orgId: string;
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  onCancel: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workspaceName = name.trim();
    if (!workspaceName) return;
    setSubmitting(true);
    setError(null);
    const outcome = await submitTeamCreation({
      loginToken: props.loginToken,
      orgId: props.orgId,
      name: workspaceName,
      ...props.query,
    });
    setSubmitting(false);
    if (outcome.kind === 'error') {
      setError(t('form.error.generic'));
      return;
    }
    props.onOutcome(outcome);
  }

  return (
    <form
      id={props.id}
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-3 rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] p-3"
    >
      <Input
        label={t('workspace.createTeam.nameLabel')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={props.disabled || submitting}
        maxLength={100}
        autoFocus
        required
      />
      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={props.disabled || submitting || !name.trim()}>
          {submitting ? '...' : t('workspace.createTeam.submit')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={props.disabled || submitting}
          onClick={props.onCancel}
        >
          {t('workspace.createTeam.cancel')}
        </Button>
      </div>
    </form>
  );
}
