import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PopupProvider, usePopup } from './use-popup.js';

function ViewProbe(): React.JSX.Element {
  const { view, teamHint } = usePopup();
  return <div data-testid="probe">{`${view}:${teamHint ?? 'null'}`}</div>;
}

function renderWithSearch(search: string): string {
  return renderToString(
    <PopupProvider configUrl="" initialSearch={search}>
      <ViewProbe />
    </PopupProvider>,
  );
}

/**
 * Gap-fix B Task 2 (design §11.4): `team_hint` must never, on its own, land the SPA on the
 * workspace chooser — that only ever happens via a `login_token` bridge (which itself is only
 * minted server-side when `config.login_flow.workspace_selection === "auto"`). This is the
 * client-side half of "hint ignored under workspace_selection: off".
 */
describe('PopupProvider — team_hint does not affect initial view on its own', () => {
  it('opens the signing view only for a scoped signing continuation', () => {
    const html = renderWithSearch('?flow=signatures&signing_token=opaque-capability');

    expect(html).toContain('signatures:null');
  });

  it('stays on the login view when team_hint is present without a login_token', () => {
    const html = renderWithSearch(
      '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=team-abc123',
    );

    expect(html).toContain('login:team-abc123');
  });

  it('still parses team_hint normally alongside an unrelated login_token/flow pair', () => {
    const html = renderWithSearch(
      '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&team_hint=design&login_token=bridge.jwt&flow=workspace_chooser',
    );

    expect(html).toContain('workspace-chooser:design');
  });
});
