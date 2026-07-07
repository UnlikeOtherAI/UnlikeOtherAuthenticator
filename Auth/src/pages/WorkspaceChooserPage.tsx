import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CreateWorkspaceCard } from '../components/workspace/CreateWorkspaceCard.js';
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
    setView,
    setLoginToken,
    setWorkspaceChoices,
    redirectTo,
    startTwoFactorVerify,
    startTwoFactorSetup,
  } = usePopup();

  const [error, setError] = useState<string | null>(null);
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
      });
      if (!applied) setError(t('form.error.generic'));
      return applied;
    },
    [setLoginToken, setWorkspaceChoices, setView, redirectTo, startTwoFactorVerify, startTwoFactorSetup, t],
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
      if (choices) {
        setWorkspaceChoices(choices);
      } else {
        setHydrateFailed(true);
        setError(t('form.error.generic'));
      }
    })();
  }, [loginToken, workspaceChoices, query, setWorkspaceChoices, t]);

  // Design §11.2: a user with exactly one ACTIVE team and no pending invites never sees a
  // one-item chooser — select it for them as soon as the payload lands.
  useEffect(() => {
    if (!loginToken || !workspaceChoices || autoSkipStarted.current) return;
    const skipTeam = pickAutoSkipTeam(workspaceChoices);
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
  }, [loginToken, workspaceChoices, query, handleOutcome]);

  if (!loginToken || !workspaceChoices) {
    if (hydrateFailed) {
      return (
        <div>
          <p className="text-sm text-[var(--uoa-color-danger)]">{error ?? t('form.error.generic')}</p>
        </div>
      );
    }
    return <div />;
  }

  const skipTeam = pickAutoSkipTeam(workspaceChoices);
  if (skipTeam && !autoSkipFailed) {
    return (
      <div>
        <p className="text-sm text-[var(--uoa-color-muted)]">{t('workspaceChooser.autoSkip')}</p>
      </div>
    );
  }

  const hasInvites = workspaceChoices.pending_invites.length > 0;
  const hasTeams = workspaceChoices.teams.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className={`text-balance ${classNames.title}`}>{t('auth.workspaceChooser.title')}</h1>
        {pendingEmail ? (
          <p className="mt-1 text-sm text-[var(--uoa-color-muted)]">
            {t('workspaceChooser.subtitle', { email: pendingEmail })}
          </p>
        ) : null}
      </div>

      {error ? <p className="text-sm text-[var(--uoa-color-danger)]">{error}</p> : null}

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

      {workspaceChoices.can_create_org ? (
        <CreateWorkspaceCard loginToken={loginToken} query={query} onOutcome={handleOutcome} />
      ) : null}
    </div>
  );
}
