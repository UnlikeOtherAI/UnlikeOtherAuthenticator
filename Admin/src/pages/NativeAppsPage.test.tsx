// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAppsPage } from './NativeAppsPage';
import { NativeAppDetailPage } from './NativeAppDetailPage';

const mocks = vi.hoisted(() => ({ save: vi.fn(), refetch: vi.fn(), failed: false }));
const app = { id: 'native-1', identifier: 'com.example.browser', name: 'Browser', enabled: true,
  methods: ['google', 'email_password'], scopes: ['openid', 'profile'], allow_registration: true,
  redirect_uris: ['http://127.0.0.1:3000/callback'], primary_color: '#2563eb', background_color: '#ffffff',
  text_color: '#111827', icon_url: null, revision: 4 };
vi.mock('../features/admin/native-app-queries', () => ({
  useNativeApps: () => ({ data: [app], isPending: false, isError: mocks.failed, refetch: mocks.refetch }),
  useSaveNativeApp: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
afterEach(cleanup);
beforeEach(() => { mocks.save.mockReset().mockResolvedValue(app); mocks.failed = false; });
function mount(path = '/apps') {
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/apps" element={<NativeAppsPage />} /><Route path="/apps/:appId" element={<NativeAppDetailPage />} /></Routes></MemoryRouter>);
}
describe('native app navigation and preserved controls', () => {
  it('opens a real detail link and retains callback, branding and policy fields during an edit', async () => {
    mount();
    expect(screen.getByRole('link', { name: 'Browser' }).getAttribute('href')).toBe('/apps/native-1');
    await userEvent.click(screen.getByRole('link', { name: 'Browser' }));
    expect(screen.getByText('http://127.0.0.1:3000/callback')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Edit app' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save app' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ id: app.id, file: undefined, form: {
      identifier: app.identifier, name: app.name, enabled: true, methods: app.methods, scopes: app.scopes,
      allow_registration: true, redirect_uris: app.redirect_uris, primary_color: app.primary_color,
      background_color: app.background_color, text_color: app.text_color,
    } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps failed edits available for retry and supports direct detail URLs', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Save failed'));
    mount('/apps/native-1');
    await userEvent.click(screen.getByRole('button', { name: 'Edit app' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save app' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Save failed');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save app' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('provides retry instead of an empty result on query failure', async () => {
    mocks.failed = true; mount();
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
