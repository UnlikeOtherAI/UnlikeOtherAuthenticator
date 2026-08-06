import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitTeamCreation } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/**
 * "New workspace" inside one organisation the user already belongs to.
 *
 * Distinct from `CreateWorkspaceCard`, which creates a user's *first organisation*: an org is the
 * level above a workspace, so this card is rendered per organisation the server marked creatable
 * (`creatable_orgs` — ACTIVE owner/admin there, and the domain opted in). The server re-checks
 * both; this only decides what to offer.
 */
export function CreateTeamCard(props: {
  orgId: string;
  orgName: string;
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
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

  if (creating) {
    return (
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="flex flex-col gap-3 rounded-[var(--uoa-radius-card)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] p-3"
      >
        <Input
          label={t('workspace.createTeam.nameLabel')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={props.disabled || submitting}
          maxLength={100}
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
            onClick={() => {
              setCreating(false);
              setError(null);
            }}
          >
            {t('workspace.createTeam.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setCreating(true)}
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
          {t('workspace.createTeam.title')}
        </span>
        <span className="block truncate text-xs text-[var(--uoa-color-muted)]">
          {t('workspace.createTeam.subtitle', { org: props.orgName })}
        </span>
      </span>
    </button>
  );
}
