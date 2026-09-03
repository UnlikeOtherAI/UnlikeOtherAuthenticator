// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PopupProvider } from './use-popup.js';

/**
 * The signing_token cleanup already exists; the sibling bridge tokens minted by
 * /auth/callback (login_token, twofa_token, twofa_setup_token) must get the same
 * treatment once parsed, or they linger in the address bar for the whole session.
 */
let container: HTMLDivElement;
let root: Root | null;

async function mountWithSearch(search: string): Promise<void> {
  window.history.replaceState(window.history.state, '', `/${search}`);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PopupProvider configUrl="">
        <div />
      </PopupProvider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  window.history.replaceState(window.history.state, '', '/');
});

describe('PopupProvider — bridge tokens are stripped from the URL once parsed', () => {
  it('removes login_token with its flow', async () => {
    await mountWithSearch(
      '?config_url=https%3A%2F%2Fclient.example.com%2Fauth-config&login_token=bridge.jwt&flow=team_chooser',
    );

    expect(window.location.search).not.toContain('login_token');
  });

  it('removes twofa_token and twofa_setup_token', async () => {
    await mountWithSearch('?twofa_token=twofa.jwt&twofa_setup_token=setup.jwt');

    expect(window.location.search).not.toContain('twofa_token');
    expect(window.location.search).not.toContain('twofa_setup_token');
  });

  it('leaves unrelated query params untouched', async () => {
    await mountWithSearch('?team_hint=design&twofa_token=twofa.jwt');

    const params = new URLSearchParams(window.location.search);
    expect(params.get('team_hint')).toBe('design');
    expect(params.get('twofa_token')).toBeNull();
  });
});
