// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagDetailPage } from './FeatureFlagDetailPage';
import { mockAdminData } from '../features/admin/__mocks__/mock-data';
const mocks = vi.hoisted(() => ({ updateFlag: vi.fn(), updateRule: vi.fn(), deleteFlag: vi.fn(), deleteRule: vi.fn(), confirm: vi.fn() }));
vi.mock('../features/shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: mocks.confirm }) }));
vi.mock('../features/admin/admin-queries', () => ({
  useSettingsQuery: () => ({ data: mockAdminData, isLoading: false, isError: false }),
  useUpdateFeatureFlagMutation: () => ({ mutateAsync: mocks.updateFlag }),
  useUpdateKillSwitchMutation: () => ({ mutateAsync: mocks.updateRule }),
  useDeleteFeatureFlagMutation: () => ({ mutateAsync: mocks.deleteFlag }),
  useDeleteKillSwitchMutation: () => ({ mutateAsync: mocks.deleteRule }),
  useCreateFeatureFlagMutation: () => ({ mutateAsync: vi.fn() }),
  useCreateKillSwitchMutation: () => ({ mutateAsync: vi.fn() }),
}));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });
function mount(query = '') { render(<MemoryRouter initialEntries={[`/feature-flags/app2${query}`]}><Routes><Route path="/feature-flags/:appId" element={<FeatureFlagDetailPage />} /></Routes></MemoryRouter>); }
describe('feature flag routes preserve live actions', () => {
  it('opens an addressable flag editor and submits the existing definition', async () => {
    mount();
    const link = screen.getByRole('link', { name: 'integrations_v2' });
    expect(link.getAttribute('href')).toContain('flag=');
    await userEvent.click(link);
    expect(screen.getByRole('dialog', { name: 'Edit Feature Flag' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateFlag).toHaveBeenCalledWith(expect.objectContaining({ key: 'integrations_v2' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('retains explicit confirmed deletion and removes unsupported write controls', async () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Add Platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Group' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Delete integrations_v2' }));
    expect(mocks.deleteFlag).not.toHaveBeenCalled();
    await mocks.confirm.mock.calls[0]?.[2]();
    expect(mocks.deleteFlag).toHaveBeenCalledOnce();
  });
  it('keeps polling information in addressable read-only settings', () => {
    mount('?tab=settings');
    expect(screen.getByText('Poll interval')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});


it('keeps flag and rule pages independent and resets the platform filter page', async () => {
  const app = mockAdminData.apps.find((item) => item.id === 'app2');
  if (!app?.flagDefinitions[0] || !app.platforms[0]) throw new Error('Missing flag fixture');
  const template = app.flagDefinitions[0];
  const platformId = app.platforms[0].id;
  const original = app.flagDefinitions;
  app.flagDefinitions = Array.from({ length: 12 }, (_, index) => ({ ...template, id: `fixture-${index}`, key: `fixture_${index}`, platformMode: 'all' }));
  try {
    mount('?flagsPage=2&rulesPage=1');
    expect(screen.getByRole('link', { name: 'fixture_10' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'fixture_0' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Platform' }), platformId);
    await waitFor(() => expect(screen.getByRole('link', { name: 'fixture_0' })).toBeTruthy());
  } finally { app.flagDefinitions = original; }
});
