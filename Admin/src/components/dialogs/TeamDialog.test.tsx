// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamDialog } from './TeamDialog';

const team = { id: 'team', orgId: 'org', name: 'Engineering', description: 'Build', members: 0, isDefault: false, allowedEmails: [], allowedEmailDomains: [] };
afterEach(cleanup);

it('retains a failed edit for retry and saves the existing exact update fields', async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  const onClose = vi.fn();
  render(<TeamDialog open team={team} onSave={onSave} onClose={onClose} />);
  const user = userEvent.setup();
  await user.clear(screen.getByPlaceholderText('Engineering'));
  await user.type(screen.getByPlaceholderText('Engineering'), 'Platform');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(/Could not save the team/)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSave).toHaveBeenCalledWith({ name: 'Platform', description: 'Build' });
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it('requires discard confirmation before closing an edited team', async () => {
  const onClose = vi.fn();
  render(<TeamDialog open team={team} onSave={vi.fn()} onClose={onClose} />);
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Engineering'), ' 2');
  await user.click(screen.getByRole('button', { name: 'Close modal' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
