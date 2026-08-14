import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input, fieldInputClassName } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery, WorkspaceJoinPolicy } from '../../utils/api.js';
import { submitWorkspaceCreation } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

const visibilityDescriptionKeys = {
  HIDDEN: 'workspace.createDialog.visibility.privateDescription',
  INVITE_ONLY: 'workspace.createDialog.visibility.inviteOnlyDescription',
  OPEN_TO_ORG: 'workspace.createDialog.visibility.openToOrganisationDescription',
} as const;

/**
 * First-workspace creation belongs in the otherwise empty chooser, rather than behind a floating
 * action and modal. The server still creates the organisation and validates the capability.
 */
export function CreateFirstWorkspaceForm(props: {
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visibilityId = useId();
  const visibilityDescriptionId = useId();
  const [name, setName] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<WorkspaceJoinPolicy>('INVITE_ONLY');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const workspaceName = name.trim();
    if (!workspaceName) return;

    setSubmitting(true);
    setError(null);
    const outcome = await submitWorkspaceCreation({
      loginToken: props.loginToken,
      name: workspaceName,
      joinPolicy,
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
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
      <p className="text-sm text-[var(--uoa-color-muted)]">
        {t('workspace.createDialog.newOrganisationDescription')}
      </p>

      <Input
        label={t('workspace.createOrg.nameLabel')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={submitting}
        maxLength={100}
        autoFocus
        required
      />

      <div>
        <label
          htmlFor={visibilityId}
          className="text-sm font-medium text-[var(--uoa-color-text)]"
        >
          {t('workspace.createDialog.visibilityLabel')}
        </label>
        <select
          id={visibilityId}
          value={joinPolicy}
          onChange={(event) => setJoinPolicy(event.target.value as WorkspaceJoinPolicy)}
          disabled={submitting}
          aria-describedby={visibilityDescriptionId}
          className={fieldInputClassName('appearance-auto')}
        >
          <option value="HIDDEN">{t('workspace.createDialog.visibility.private')}</option>
          <option value="INVITE_ONLY">{t('workspace.createDialog.visibility.inviteOnly')}</option>
          <option value="OPEN_TO_ORG">
            {t('workspace.createDialog.visibility.openToOrganisation')}
          </option>
        </select>
        <p id={visibilityDescriptionId} className="mt-1 text-xs text-[var(--uoa-color-muted)]">
          {t(visibilityDescriptionKeys[joinPolicy])}
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

      <Button type="submit" disabled={submitting || !name.trim()}>
        {submitting ? '...' : t('workspace.createDialog.submit')}
      </Button>
    </form>
  );
}
