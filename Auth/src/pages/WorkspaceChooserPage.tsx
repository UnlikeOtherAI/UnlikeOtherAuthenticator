import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CreateFirstWorkspaceForm } from '../components/workspace/CreateFirstWorkspaceForm.js';
import { CreateWorkspaceDialog } from '../components/workspace/CreateWorkspaceDialog.js';
import { InviteCard } from '../components/workspace/InviteCard.js';
import { WorkspaceList } from '../components/workspace/WorkspaceList.js';
import { usePopup } from '../hooks/use-popup.js';
import { useTheme } from '../hooks/use-theme.js';
import { useTranslation } from '../i18n/use-translation.js';
import type { AuthFlowQuery } from '../utils/api.js';
import { submitSessionChoices, submitTeamSelection } from '../utils/workspace-actions.js';
import {
  applyWorkspaceOutcome,
  pickAutoSkipTeam,
  pickHintTeam,
  type WorkspaceResponseOutcome,
} from '../utils/workspace-response.js';

/**
 * Phase 3c (design §11.2): the Slack "choose a workspace" screen. Reads `loginToken` +
 * `workspaceChoices` from `usePopup()` — set by `CodeEntryPage` or a chooser-producing
 * `LoginForm` submit — and never round-trips to the server itself except through the
 * cards/auto-skip below (all funnelled through `submitTeamSelection`).
 *
 * Phase 3c follow-up (design §4.3 Task 7 remainder): the social callback can only seed
 * `loginToken` via redirect (no inline payload), so when this page mounts with a `loginToken`
 * but no `workspaceChoices` yet, it hydrates them itself via `POST /auth/session-choices`.
 */
export function WorkspaceChooserPage(): React.JSX.Element {
  const { classNames } = useTheme();
  const { t } = useTranslation();
  const {
    loginToken,
    workspaceChoices,
    pendingEmail,
    configUrl,
    redirectUrl,
    codeChallenge,
    codeChallengeMethod,
    requestAccess,
    teamHint,
    setView,
    setLoginToken,
    setWorkspaceChoices,
    redirectTo,
    startTwoFactorVerify,
    startTwoFactorSetup,
    setNotice,
  } = usePopup();

  const [error, setError] = useState<string | null>(null);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [autoSkipFailed, setAutoSkipFailed] = useState(false);
  const [hydrateFailed, setHydrateFailed] = useState(false);
  const autoSkipStarted = useRef(false);
  const hydrateStarted = useRef(false);

  const query = useMemo<AuthFlowQuery>(
    () => ({ configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess }),
    [configUrl, redirectUrl, codeChallenge, codeChallengeMethod, requestAccess],
  );

  const handleOutcome = useCallback(
    (outcome: WorkspaceResponseOutcome) => {
      const applied = applyWorkspaceOutcome(outcome, {
        setLoginToken,
        setWorkspaceChoices,
        setView,
        redirectTo,
        startTwoFactorVerify,
        startTwoFactorSetup,
        setNotice,
      });
      if (!applied) setError(t('form.error.generic'));
      return applied;
    },
    [
      setLoginToken,
      setWorkspaceChoices,
      setView,
      redirectTo,
      startTwoFactorVerify,
      startTwoFactorSetup,
      setNotice,
      t,
    ],
  );

  // Not reachable directly (no login_token at all) — bounce back to login. A login_token with no
  // workspaceChoices yet is the social-callback hydration path below, not an invalid state.
  useEffect(() => {
    if (!loginToken) setView('login');
  }, [loginToken, setView]);

  // Phase 3c follow-up (design §4.3 Task 7 remainder): hydrate the chooser payload when we landed
  // here via the social-callback redirect (loginToken seeded, workspaceChoices not — CodeEntryPage
  // and the chooser-producing LoginForm always set both together, so this is a no-op for them).
  useEffect(() => {
    if (!loginToken || workspaceChoices || hydrateStarted.current) return;
    hydrateStarted.current = true;
    void (async () => {
      const choices = await submitSessionChoices({ loginToken, ...query });
      if (choices === 'expired') {
        // Nothing on this screen can succeed with a dead bridge, so don't strand the user on an
        // error they cannot act on — send them back to sign in, which resumes this same request.
        handleOutcome({ kind: 'expired' });
        return;
      }
      if (choices) {
        setWorkspaceChoices(choices);
      } else {
        setHydrateFailed(true);
        setError(t('form.error.generic'));
      }
    })();
  }, [loginToken, workspaceChoices, query, setWorkspaceChoices, handleOutcome, t]);

  // Design §11.2: a user with exactly one ACTIVE team and no pending invites never sees a
  // one-item chooser — select it for them as soon as the payload lands. Gap-fix B Task 2 (design
  // §11.4): a `team_hint` deep-link/switch preselect rides the SAME auto-select code path — it
  // only ever matches a team already present in this user's own chooser payload.
  useEffect(() => {
    if (!loginToken || !workspaceChoices || autoSkipStarted.current) return;
    const skipTeam = pickAutoSkipTeam(workspaceChoices) ?? pickHintTeam(workspaceChoices, teamHint);
    if (!skipTeam) return;

    autoSkipStarted.current = true;
    void (async () => {
      const outcome = await submitTeamSelection({
        loginToken,
        teamId: skipTeam.teamId,
        ...query,
      });
      const applied = handleOutcome(outcome);
      if (!applied) setAutoSkipFailed(true);
    })();
  }, [loginToken, workspaceChoices, teamHint, query, handleOutcome]);

  if (!loginToken || !workspaceChoices) {
    if (hydrateFailed) {
      return (
        <div>
          <p className="text-sm text-[var(--uoa-color-danger)]">
            {error ?? t('form.error.generic')}
          </p>
        </div>
      );
    }
    return <div />;
  }

  const skipTeam = pickAutoSkipTeam(workspaceChoices) ?? pickHintTeam(workspaceChoices, teamHint);
  if (skipTeam && !autoSkipFailed) {
    return (
      <div>
        <p className="text-sm text-[var(--uoa-color-muted)]">{t('workspaceChooser.autoSkip')}</p>
      </div>
    );
  }

  const hasInvites = workspaceChoices.pending_invites.length > 0;
  const hasTeams = workspaceChoices.teams.length > 0;
  // Orgs this user may add a workspace to (server-decided: ACTIVE owner/admin + the domain's
  // `allow_user_create_team`). Unlike `can_create_org` below this is NOT limited to users with no
  // workspace yet — creating a workspace inside an org you already run is an ordinary action.
  const creatableOrgs = workspaceChoices.creatable_orgs;
  // Creating an organisation is an independent, server-gated destination. A user may own more
  // than one organisation, so keep it available alongside organisations that can host a new team.
  const canCreateNewOrganisation = workspaceChoices.can_create_org;
  // With no usable workspace or invitation there is no organisation destination to pick. Put the
  // first-workspace form directly in the chooser rather than stranding it behind a floating modal.
  const showInlineFirstWorkspaceForm =
    canCreateNewOrganisation && !hasTeams && !hasInvites && creatableOrgs.length === 0;
  // The inline first-workspace form already exposes the only available creation destination, so
  // do not duplicate it with the floating trigger. Every other permitted destination opens the
  // custom picker.
  const canOpenCreateDialog =
    creatableOrgs.length > 0 || (canCreateNewOrganisation && !showInlineFirstWorkspaceForm);

  return (
    <div className="flex flex-col gap-4">
      {canOpenCreateDialog ? (
        <button
          type="button"
          onClick={() => setIsCreateDialogOpen(true)}
          aria-label={t('workspace.createDialog.open')}
          title={t('workspace.createDialog.open')}
          aria-haspopup="dialog"
          aria-expanded={isCreateDialogOpen}
          // The user requested a further 12px upward adjustment after testing the quarter-overlap
          // placement. The 48px button keeps the touch target generous around the 40px control.
          className="absolute -right-[31px] -top-[26px] z-10 flex h-12 w-12 items-center justify-center text-[var(--uoa-color-primary)]"
        >
          <span
            aria-hidden="true"
            // This surface is intentionally opaque: the workspace rows must never show through
            // the floating control when the card scrolls underneath it.
            className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--uoa-color-border)] bg-[var(--uoa-color-surface)] text-xl leading-none shadow-sm transition-colors hover:border-[var(--uoa-color-primary)]"
          >
            +
          </span>
        </button>
      ) : null}

      <div>
        <h1 className={`text-balance ${classNames.title}`}>{t('auth.workspaceChooser.title')}</h1>
        {pendingEmail ? (
          <p className="mt-1 text-sm text-[var(--uoa-color-muted)]">
            {t('workspaceChooser.subtitle', { email: pendingEmail })}
          </p>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

      {showInlineFirstWorkspaceForm ? (
        <CreateFirstWorkspaceForm loginToken={loginToken} query={query} onOutcome={handleOutcome} />
      ) : null}

      {hasInvites ? (
        <div className="flex flex-col gap-3">
          {workspaceChoices.pending_invites.map((invite) => (
            <InviteCard
              key={invite.inviteId}
              invite={invite}
              loginToken={loginToken}
              query={query}
              onOutcome={handleOutcome}
            />
          ))}
        </div>
      ) : null}

      {hasTeams ? (
        <WorkspaceList
          teams={workspaceChoices.teams}
          loginToken={loginToken}
          query={query}
          onOutcome={handleOutcome}
        />
      ) : null}

      {isCreateDialogOpen ? (
        <CreateWorkspaceDialog
          loginToken={loginToken}
          query={query}
          creatableOrgs={creatableOrgs}
          canCreateNewOrganisation={canCreateNewOrganisation}
          onOutcome={handleOutcome}
          onClose={() => setIsCreateDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
