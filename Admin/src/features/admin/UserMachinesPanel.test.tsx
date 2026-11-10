// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { UserMachinesPanel } from './UserMachinesPanel';

const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn(), confirm: vi.fn() }));
vi.mock('../../services/machine-service', () => ({ machineService: { list: mocks.list, revoke: mocks.revoke } }));
vi.mock('../shell/admin-ui', () => ({ useAdminUi: () => ({ confirm: mocks.confirm }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('offers cross-product bulk retirement when the latest 100 ended records hide older approvals', async () => {
  mocks.list.mockResolvedValue({ version: 1, truncated: true, data: Array.from({ length: 100 }, (_, index) => ({
    enrollment_id: `ended-${index}`, device_name: 'Fictional computer', client_domain: 'product.example.com',
    organization_id: 'fictional-org', team_id: 'fictional-team', organization_name: 'Studio', team_name: 'Design',
    decision: 'revoked', reason: 'device_revoked', created_at: '2026-11-10T20:00:00Z',
  })) });
  mocks.revoke.mockResolvedValue({ ok: true, version: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><UserMachinesPanel userId="fictional-person" personLabel="Alex Example" /></QueryClientProvider>);
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Revoke all computer approvals' }));
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  expect(mocks.confirm.mock.calls[0][1]).toContain('across every product and team');
  await mocks.confirm.mock.calls[0][2]();
  expect(mocks.revoke).toHaveBeenCalledWith('fictional-person', undefined);
});
