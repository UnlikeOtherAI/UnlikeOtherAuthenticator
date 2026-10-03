// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Organisation, UserSummary } from '../../features/admin/types';
import { AddUserToTeamDialog } from './AddUserToTeamDialog';

vi.mock('../../config/env', () => ({ adminEnv: { apiBaseUrl: '' } }));
const person: UserSummary = {
  id: 'person',
  name: 'Test Person',
  email: 'person@example.com',
  domains: [],
  twofa: false,
  lastLogin: 'Never',
  status: 'active',
  method: 'google',
  created: '2026-10-03',
};
const orgs: Organisation[] = ['Family', 'Work'].map((name) => ({
  id: name,
  name,
  slug: name.toLowerCase(),
  allowedEmailDomains: [],
  allowedEmails: [],
  created: '2026-10-03',
  owner: person,
  twoFaPolicy: 'inherit',
  members: [],
  preapprovedMembers: [],
  teams: ['Default', 'Media'].map((team, index) => ({
    id: `${name}-${team}`,
    orgId: name,
    name: `${name} ${team}`,
    description: '',
    isDefault: index === 0,
    members: 0,
    allowedEmailDomains: [],
    allowedEmails: [],
  })),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(organisations = orgs) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['admin', 'organisations'], []);
  const onClose = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <AddUserToTeamDialog open user={person} organisations={organisations} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { client, onClose, ...view };
}

describe('AddUserToTeamDialog', () => {
  it('sends the selected org, team and role and invalidates membership views before closing', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetcher);
    const { client, onClose } = setup();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Target team'), 'Family-Media');
    await user.selectOptions(screen.getByLabelText('Organisation'), 'Work');
    expect((screen.getByLabelText('Target team') as HTMLSelectElement).value).toBe('Work-Default');
    await user.selectOptions(screen.getByLabelText('Target team'), 'Work-Media');
    await user.selectOptions(screen.getByLabelText('Team role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toContain('/internal/admin/users/person/teams');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ orgId: 'Work', teamId: 'Work-Media', teamRole: 'admin' }),
    });
    expect(client.getQueryState(['admin', 'organisations'])?.isInvalidated).toBe(true);
  });

  it('keeps failed selections for retry and blocks dismissal and repeat submits while pending', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal('fetch', fetcher);
    const { onClose } = setup();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Target team'), 'Family-Media');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(onClose).not.toHaveBeenCalled();
    finish(new Response('{}', { status: 400 }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Target team') as HTMLSelectElement).value).toBe('Family-Media');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('handles asynchronously loaded organisations and resets after closing', async () => {
    const { client, onClose, rerender } = setup([]);
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    const update = (open: boolean) =>
      rerender(
        <QueryClientProvider client={client}>
          <AddUserToTeamDialog open={open} user={person} organisations={orgs} onClose={onClose} />
        </QueryClientProvider>,
      );
    update(true);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Team role'), 'admin');
    await user.selectOptions(screen.getByLabelText('Organisation'), 'Work');
    update(false);
    update(true);
    expect((screen.getByLabelText('Organisation') as HTMLSelectElement).value).toBe('Family');
    expect((screen.getByLabelText('Team role') as HTMLSelectElement).value).toBe('member');
  });
});
