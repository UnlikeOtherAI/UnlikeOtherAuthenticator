import React, { useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery } from '../../utils/api.js';
import { submitWorkspaceCreation } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';

/**
 * The chooser's self-service entrypoint. The server derives the tenant slug
 * from this name and creates its default team before finalizing the SSO flow.
 */
export function CreateWorkspaceCard(props: {
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
    const outcome = await submitWorkspaceCreation({
      loginToken: props.loginToken,
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
          label={t('workspace.createOrg.nameLabel')}
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
            {submitting ? '...' : t('workspace.createOrg.submit')}
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
            {t('workspace.createOrg.cancel')}
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
          {t('workspace.createOrg.title')}
        </span>
        <span className="block truncate text-xs text-[var(--uoa-color-muted)]">
          {t('workspace.createOrg.subtitle')}
        </span>
      </span>
    </button>
  );
}
