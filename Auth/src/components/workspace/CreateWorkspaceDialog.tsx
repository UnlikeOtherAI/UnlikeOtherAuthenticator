import React, { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '../ui/Button.js';
import { Input, fieldInputClassName } from '../ui/Input.js';
import type { CreatableOrgChoice } from '../../hooks/use-popup.js';
import { useTranslation } from '../../i18n/use-translation.js';
import type { AuthFlowQuery, WorkspaceJoinPolicy } from '../../utils/api.js';
import { submitTeamCreation, submitWorkspaceCreation } from '../../utils/workspace-actions.js';
import type { WorkspaceResponseOutcome } from '../../utils/workspace-response.js';
import {
  OrganisationDestinationDropdown,
  type OrganisationDestinationOption,
} from './OrganisationDestinationDropdown.js';

const NEW_ORGANISATION = '__new_organisation__';

const visibilityDescriptionKeys = {
  HIDDEN: 'workspace.createDialog.visibility.privateDescription',
  INVITE_ONLY: 'workspace.createDialog.visibility.inviteOnlyDescription',
  OPEN_TO_ORG: 'workspace.createDialog.visibility.openToOrganisationDescription',
} as const;

/**
 * The chooser's one creation dialog. Its destination is intentionally constrained to the
 * server-provided `creatable_orgs` or the separate new-organisation capability; the browser
 * never invents an org id and both routes re-authorize before they write.
 */
export function CreateWorkspaceDialog(props: {
  loginToken: string;
  query: AuthFlowQuery;
  creatableOrgs: CreatableOrgChoice[];
  canCreateNewOrganisation: boolean;
  onOutcome: (outcome: WorkspaceResponseOutcome) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const onClose = props.onClose;
  const destinationId = useId();
  const destinationLabelId = useId();
  const visibilityId = useId();
  const visibilityDescriptionId = useId();
  const destinationOptions = useMemo<OrganisationDestinationOption[]>(
    () => [
      ...(props.canCreateNewOrganisation
        ? [{ value: NEW_ORGANISATION, label: t('workspace.createDialog.newOrganisation') }]
        : []),
      ...props.creatableOrgs.map((org) => ({ value: org.orgId, label: org.orgName })),
    ],
    [props.canCreateNewOrganisation, props.creatableOrgs, t],
  );
  const initialDestination = destinationOptions[0]?.value ?? '';
  const [destination, setDestination] = useState(initialDestination);
  const [name, setName] = useState('');
  // Preserve the hosted creation API's established default. Private remains an explicit choice.
  const [joinPolicy, setJoinPolicy] = useState<WorkspaceJoinPolicy>('INVITE_ONLY');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNewOrganisation = destination === NEW_ORGANISATION;
  const hasMultipleDestinations = destinationOptions.length > 1;
  const selectedOrganisation = props.creatableOrgs.find((org) => org.orgId === destination);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, submitting]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const workspaceName = name.trim();
    if (!workspaceName || (!isNewOrganisation && !selectedOrganisation)) return;

    setSubmitting(true);
    setError(null);
    let outcome: WorkspaceResponseOutcome;
    if (isNewOrganisation) {
      outcome = await submitWorkspaceCreation({
        loginToken: props.loginToken,
        name: workspaceName,
        joinPolicy,
        ...props.query,
      });
    } else {
      // Keep this second guard local to the branch so TypeScript and the request itself both
      // preserve the invariant that an existing destination always came from creatable_orgs.
      if (!selectedOrganisation) {
        setSubmitting(false);
        return;
      }
      outcome = await submitTeamCreation({
        loginToken: props.loginToken,
        orgId: selectedOrganisation.orgId,
        name: workspaceName,
        joinPolicy,
        ...props.query,
      });
    }
    setSubmitting(false);
    if (outcome.kind === 'error') {
      setError(t('form.error.generic'));
      return;
    }
    props.onOutcome(outcome);
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) props.onClose();
      }}
      // `p-3` is deliberately 12px. Together with the full-width dialog it guarantees at least
      // 12px between the dialog and either mobile viewport edge.
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-3"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-workspace-dialog-title"
        onSubmit={(event) => void handleSubmit(event)}
        className="max-h-[calc(100dvh-24px)] w-full max-w-md overflow-y-auto rounded-[var(--uoa-radius-card)] bg-[var(--uoa-color-surface)] p-5 shadow-xl"
      >
        <div className="flex flex-col gap-4">
          <div>
            <h2
              id="create-workspace-dialog-title"
              className="text-lg font-semibold text-[var(--uoa-color-text)]"
            >
              {t('workspace.createDialog.title')}
            </h2>
            <p className="mt-1 text-sm text-[var(--uoa-color-muted)]">
              {t('workspace.createDialog.subtitle')}
            </p>
          </div>

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
              id={destinationLabelId}
              htmlFor={destinationId}
              className="text-sm font-medium text-[var(--uoa-color-text)]"
            >
              {t('workspace.createDialog.destinationLabel')}
            </label>
            {hasMultipleDestinations ? (
              <OrganisationDestinationDropdown
                id={destinationId}
                value={destination}
                options={destinationOptions}
                labelId={destinationLabelId}
                onChange={setDestination}
                disabled={submitting}
              />
            ) : (
              <p className="mt-1 rounded-[var(--uoa-radius-input)] border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] px-3 py-2 text-sm text-[var(--uoa-color-text)]">
                {isNewOrganisation
                  ? t('workspace.createDialog.newOrganisation')
                  : (selectedOrganisation?.orgName ?? '')}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--uoa-color-muted)]">
              {isNewOrganisation
                ? t('workspace.createDialog.newOrganisationDescription')
                : t('workspace.createDialog.existingOrganisationDescription')}
            </p>
          </div>

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
              <option value="INVITE_ONLY">
                {t('workspace.createDialog.visibility.inviteOnly')}
              </option>
              <option value="OPEN_TO_ORG">
                {t('workspace.createDialog.visibility.openToOrganisation')}
              </option>
            </select>
            <p id={visibilityDescriptionId} className="mt-1 text-xs text-[var(--uoa-color-muted)]">
              {t(visibilityDescriptionKeys[joinPolicy])}
            </p>
          </div>

          {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? '...' : t('workspace.createDialog.submit')}
            </Button>
            <Button type="button" variant="secondary" disabled={submitting} onClick={props.onClose}>
              {t('workspace.createDialog.cancel')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
