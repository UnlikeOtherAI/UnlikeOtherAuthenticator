// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebugFab } from './DebugFab';

// A real-looking HS256 superuser JWT (header.payload.signature) seeded into sessionStorage.
const RAW_ACCESS_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJ1c2VySWQiOiJ1c2VyLTEiLCJlbWFpbCI6InN1cGVyQGV4YW1wbGUuY29tIiwicm9sZSI6InN1cGVydXNlciJ9.' +
  'c2lnbmF0dXJl';

function seedSession(): void {
  window.sessionStorage.setItem(
    'uoa-admin-session',
    JSON.stringify({ accessToken: RAW_ACCESS_TOKEN, expiresAt: Date.now() + 60_000 }),
  );
}

async function renderSnapshot(): Promise<string> {
  const user = userEvent.setup();
  render(<DebugFab />);
  await user.click(screen.getByRole('button', { name: 'Debug session snapshot' }));
  return (screen.getByLabelText('Session snapshot JSON') as HTMLTextAreaElement).value;
}

describe('DebugFab snapshot', () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it('never contains the raw access token or a Bearer replay affordance', async () => {
    seedSession();

    const json = await renderSnapshot();

    expect(json).not.toContain(RAW_ACCESS_TOKEN);
    expect(json).not.toContain('Bearer ey');
    expect(json).not.toContain('curl');

    const snapshot = JSON.parse(json) as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('accessToken');
    expect(snapshot).not.toHaveProperty('reconstruct');
    expect(json).toContain('super@example.com');
  });

  it('describes the snapshot as non-secret diagnostics, not a reproducible request', async () => {
    seedSession();

    await renderSnapshot();

    expect(screen.getByText(/Non-secret diagnostics/)).toBeTruthy();
    expect(screen.queryByText(/reproduce/)).toBeNull();
  });
});
