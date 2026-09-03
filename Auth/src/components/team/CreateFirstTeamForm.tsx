import React, { useId, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input, fieldInputClassName } from '../ui/Input.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery, TeamJoinPolicy } from '../../utils/api.js';
import { submitOrganisationCreation } from '../../utils/team-actions.js';
import type { TeamResponseOutcome } from '../../utils/team-response.js';

const visibilityDescriptionKeys = {
  HIDDEN: 'team.createDialog.visibility.privateDescription',
  INVITE_ONLY: 'team.createDialog.visibility.inviteOnlyDescription',
  OPEN_TO_ORG: 'team.createDialog.visibility.openToOrganisationDescription',
} as const;

/**
 * First-team creation belongs in the otherwise empty chooser, rather than behind a floating
 * action and modal. The server still creates the organisation and validates the capability.
 */
export function CreateFirstTeamForm(props: {
  loginToken: string;
  query: AuthFlowQuery;
  onOutcome: (outcome: TeamResponseOutcome) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visibilityId = useId();
  const visibilityDescriptionId = useId();
  const [name, setName] = useState('');
  const [joinPolicy, setJoinPolicy] = useState<TeamJoinPolicy>('INVITE_ONLY');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const teamName = name.trim();
    if (!teamName) return;

    setSubmitting(true);
    setError(null);
    const outcome = await submitOrganisationCreation({
      loginToken: props.loginToken,
      name: teamName,
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
        {t('team.createDialog.newOrganisationDescription')}
      </p>

      <Input
        label={t('team.createOrg.nameLabel')}
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
          {t('team.createDialog.visibilityLabel')}
        </label>
        <select
          id={visibilityId}
          value={joinPolicy}
          onChange={(event) => setJoinPolicy(event.target.value as TeamJoinPolicy)}
          disabled={submitting}
          aria-describedby={visibilityDescriptionId}
          className={fieldInputClassName('appearance-auto')}
        >
          <option value="HIDDEN">{t('team.createDialog.visibility.private')}</option>
          <option value="INVITE_ONLY">{t('team.createDialog.visibility.inviteOnly')}</option>
          <option value="OPEN_TO_ORG">
            {t('team.createDialog.visibility.openToOrganisation')}
          </option>
        </select>
        <p id={visibilityDescriptionId} className="mt-1 text-xs text-[var(--uoa-color-muted)]">
          {t(visibilityDescriptionKeys[joinPolicy])}
        </p>
      </div>

      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

      <Button type="submit" disabled={submitting || !name.trim()}>
        {submitting ? '...' : t('team.createDialog.submit')}
      </Button>
    </form>
  );
}
